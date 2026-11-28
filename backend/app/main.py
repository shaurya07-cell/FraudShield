"""FastAPI application for FraudShield with real-time scoring, streaming, and graph analytics."""
import asyncio
from contextlib import asynccontextmanager
from typing import Any, Dict, List, Optional

from fastapi import FastAPI, HTTPException, WebSocket, WebSocketDisconnect
from fastapi.middleware.cors import CORSMiddleware

from app.graph_engine import GLOBAL_GRAPH
from app.gateway import GATEWAY, router as gateway_router
from app.razorpay_gateway import RAZORPAY_LEDGER, router as razorpay_router
from app.metrics import METRICS
from app.schemas import ScoredTransaction, Transaction
from app.scorer import score_transaction
from app import simulator
from app.state import reset as reset_state


class ConnectionManager:
    """Manages active WebSocket subscribers for live scored transaction streaming."""

    def __init__(self):
        self.active_connections: List[WebSocket] = []
        self._lock = asyncio.Lock()

    async def connect(self, websocket: WebSocket) -> None:
        await websocket.accept()
        async with self._lock:
            self.active_connections.append(websocket)

    async def disconnect(self, websocket: WebSocket) -> None:
        async with self._lock:
            if websocket in self.active_connections:
                self.active_connections.remove(websocket)

    async def broadcast(self, message: Dict[str, Any]) -> None:
        """Broadcast JSON payload to all connected clients; gracefully discard disconnected ones."""
        async with self._lock:
            disconnected: List[WebSocket] = []
            for connection in self.active_connections:
                try:
                    await connection.send_json(message)
                except Exception:
                    disconnected.append(connection)

            for conn in disconnected:
                if conn in self.active_connections:
                    self.active_connections.remove(conn)


ws_manager = ConnectionManager()
background_task: Optional[asyncio.Task] = None


async def background_ring_detection_loop():
    """Periodic background task executing graph cycle/ring detection out-of-band."""
    while True:
        try:
            cache = GLOBAL_GRAPH.recompute_cache()
            for ring in cache.get("rings", []):
                METRICS.register_ring(ring["ring_id"])
        except Exception:
            pass
        await asyncio.sleep(1.5)


@asynccontextmanager
async def lifespan(app: FastAPI):
    """FastAPI lifespan managing startup background tasks and clean shutdown."""
    global background_task
    # Startup: spawn periodic background graph analyzer
    GATEWAY.set_broadcast_callback(ws_manager.broadcast)
    RAZORPAY_LEDGER.set_broadcast_callback(ws_manager.broadcast)
    background_task = asyncio.create_task(background_ring_detection_loop())
    yield
    # Shutdown: cancel background task
    if background_task and not background_task.done():
        background_task.cancel()
        try:
            await background_task
        except asyncio.CancelledError:
            pass


app = FastAPI(title="FraudShield", lifespan=lifespan)

# Unrestricted CORS for external frontend dashboards
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(gateway_router)
app.include_router(razorpay_router)

# Aliases on root prefix for convenience (/payments/{ref} and /payments/{ref}/receipt)
@app.get("/payments/{ref}")
def get_payment_root(ref: str):
    from app.gateway import get_payment_by_ref
    return get_payment_by_ref(ref)

@app.get("/payments/{ref}/receipt")
def get_payment_receipt_root(ref: str):
    from app.gateway import get_payment_receipt
    return get_payment_receipt(ref)

@app.get("/payments")
def list_payments_root(limit: int = 50):
    from app.gateway import list_payments
    return list_payments(limit=limit)


@app.get("/health")
def health() -> dict:
    """Health check endpoint to verify backend service readiness."""
    return {"status": "ok"}


@app.post("/score", response_model=ScoredTransaction)
async def score(transaction: Transaction) -> ScoredTransaction:
    """Synchronous fast scoring path; broadcasts result to all connected WebSocket clients."""
    scored = score_transaction(transaction)
    # Broadcast to live stream subscribers
    await ws_manager.broadcast(scored.model_dump())
    return scored


@app.websocket("/stream")
async def websocket_stream(websocket: WebSocket):
    """Live WebSocket feed pushing every scored transaction as JSON as it occurs."""
    await ws_manager.connect(websocket)
    try:
        while True:
            # Keep socket alive and listen for client messages or pings
            _ = await websocket.receive_text()
    except (WebSocketDisconnect, Exception):
        await ws_manager.disconnect(websocket)


@app.get("/metrics")
def get_metrics() -> Dict[str, Any]:
    """Retrieve rolling operational metrics, latency percentiles, and traffic breakdown."""
    return METRICS.get_metrics()


@app.get("/graph")
def get_graph() -> Dict[str, Any]:
    """Build topological graph from the last 500 scored transactions and cached ring structures."""
    recent_scored = METRICS.get_recent_scored_transactions()
    graph_cache = GLOBAL_GRAPH.get_cache()
    node_to_ring = graph_cache.get("node_to_ring", {})
    rings = graph_cache.get("rings", [])

    nodes_map: Dict[str, Dict[str, Any]] = {}
    edges_map: Dict[tuple, Dict[str, Any]] = {}

    for txn in recent_scored:
        s_id = txn.sender_id
        r_id = txn.receiver_id

        # Sender Node
        if s_id not in nodes_map:
            nodes_map[s_id] = {
                "id": s_id,
                "risk": txn.risk_score,
                "ring_id": txn.ring_id or node_to_ring.get(s_id),
                "txn_count": 0,
            }
        else:
            nodes_map[s_id]["risk"] = max(nodes_map[s_id]["risk"], txn.risk_score)
            if not nodes_map[s_id]["ring_id"]:
                nodes_map[s_id]["ring_id"] = txn.ring_id or node_to_ring.get(s_id)
        nodes_map[s_id]["txn_count"] += 1

        # Receiver Node
        if r_id not in nodes_map:
            nodes_map[r_id] = {
                "id": r_id,
                "risk": 0,
                "ring_id": node_to_ring.get(r_id),
                "txn_count": 0,
            }
        else:
            if not nodes_map[r_id]["ring_id"]:
                nodes_map[r_id]["ring_id"] = node_to_ring.get(r_id)
        nodes_map[r_id]["txn_count"] += 1

        # Edge Aggregation
        edge_key = (s_id, r_id)
        if edge_key not in edges_map:
            edges_map[edge_key] = {"source": s_id, "target": r_id, "amount": 0.0, "count": 0}
        edges_map[edge_key]["amount"] = round(edges_map[edge_key]["amount"] + txn.amount, 2)
        edges_map[edge_key]["count"] += 1

    # Ensure nodes belonging to detected rings have their ring_id assigned
    for ring in rings:
        for member in ring["members"]:
            if member in nodes_map:
                nodes_map[member]["ring_id"] = ring["ring_id"]

    nodes = list(nodes_map.values())
    edges = list(edges_map.values())

    return {
        "nodes": nodes,
        "edges": edges,
        "rings": rings,
    }


@app.post("/simulate/{scenario}")
async def simulate(scenario: str) -> Dict[str, Any]:
    """Execute a simulated payment pattern, score sequentially, and broadcast with natural pacing."""
    valid_scenarios = ["normal", "velocity_attack", "ring_attack", "fanout_cashout", "bulk_payer"]
    if scenario not in valid_scenarios:
        raise HTTPException(
            status_code=400,
            detail=f"Unknown scenario '{scenario}'. Allowed options: {valid_scenarios}",
        )

    txns = simulator.scenario(scenario)
    allowed = 0
    review = 0
    blocked = 0

    for idx, txn in enumerate(txns):
        scored = score_transaction(txn)
        await ws_manager.broadcast(scored.model_dump())

        if scored.decision == "ALLOW":
            allowed += 1
        elif scored.decision == "REVIEW":
            review += 1
        elif scored.decision == "BLOCK":
            blocked += 1

        # Pacing sleep between transactions (except the last one)
        if len(txns) > 1 and idx < len(txns) - 1:
            await asyncio.sleep(0.05)

    # For ring attacks, ensure graph cache is recomputed immediately so /graph reflects it
    if scenario == "ring_attack":
        cache = GLOBAL_GRAPH.recompute_cache()
        for ring in cache.get("rings", []):
            METRICS.register_ring(ring["ring_id"])

    return {
        "scenario": scenario,
        "count": len(txns),
        "allowed": allowed,
        "review": review,
        "blocked": blocked,
    }


@app.post("/reset")
def reset_all() -> Dict[str, str]:
    """Clear all state, transaction graphs, metrics, and recent history."""
    reset_state()
    GLOBAL_GRAPH.reset()
    METRICS.reset()
    GATEWAY.reset()
    RAZORPAY_LEDGER.reset()
    return {"status": "ok", "message": "All state, graph, and metrics reset"}


@app.get("/transactions/recent")
def get_recent_transactions() -> List[Dict[str, Any]]:
    """Retrieve the last 100 scored transactions."""
    return METRICS.get_recent_transactions(limit=100)
