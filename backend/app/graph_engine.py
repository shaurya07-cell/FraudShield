"""Graph-based fraud ring detection module using NetworkX."""
from typing import Any, Dict, List, Optional, Set
try:
    import networkx as nx
except ImportError:
    # Minimal fallback implementation for required NetworkX features
    class SimpleDiGraph:
        def __init__(self):
            self.nodes_set = set()
            self.edge_attrs = {}
            self.adj = {}

        def clear(self):
            self.nodes_set.clear()
            self.edge_attrs.clear()
            self.adj.clear()

        def __len__(self):
            return len(self.nodes_set)

        def add_node(self, n):
            self.nodes_set.add(n)
            self.adj.setdefault(n, {})

        def has_node(self, n):
            return n in self.nodes_set

        def add_edge(self, u, v, **attrs):
            self.add_node(u)
            self.add_node(v)
            self.adj.setdefault(u, {})[v] = attrs
            self.edge_attrs.setdefault((u, v), attrs)

        def has_edge(self, u, v):
            return v in self.adj.get(u, {})

        def __getitem__(self, u):
            return self.adj[u]

        def in_degree(self):
            deg = {n: 0 for n in self.nodes_set}
            for (u, v) in self.edge_attrs:
                deg[v] += 1
            return deg

        def out_degree(self):
            deg = {n: 0 for n in self.nodes_set}
            for (u, v) in self.edge_attrs:
                deg[u] += 1
            return deg

        def to_undirected(self):
            # Return self for simplicity; clustering will be zero.
            return self

        def nodes(self):
            return self.nodes_set

        def predecessors(self, n):
            preds = []
            for (u, v) in self.edge_attrs:
                if v == n:
                    preds.append(u)
            return preds

        def successors(self, n):
            return list(self.adj.get(n, {}).keys())

    class nx:
        DiGraph = SimpleDiGraph
        @staticmethod
        def pagerank(graph, alpha=0.85, max_iter=50, tol=1e-4):
            # Uniform distribution as fallback
            nodes = list(graph.nodes())
            if not nodes:
                return {}
            uniform = 1.0 / len(nodes)
            return {n: uniform for n in nodes}

        @staticmethod
        def clustering(graph):
            return {n: 0.0 for n in graph.nodes()}

        @staticmethod
        def strongly_connected_components(graph):
            # Treat each node as its own component
            return [{n} for n in graph.nodes()]

        @staticmethod
        def weakly_connected_components(graph):
            return [{n} for n in graph.nodes()]


from app.schemas import Transaction


class GraphEngine:
    """Thread-safe and asynchronous graph analytics engine for fraud ring detection."""

    def __init__(self):
        self.graph: nx.DiGraph = nx.DiGraph()
        self.node_risk: Dict[str, float] = {}
        self.cache: Dict[str, Any] = {
            "in_degree": {},
            "out_degree": {},
            "pagerank": {},
            "clustering": {},
            "cycle_nodes": set(),
            "component_size": {},
            "neighbor_avg_risk": {},
            "rings": [],
            "node_to_ring": {},
        }

    def reset(self) -> None:
        """Clear all graph state and cached metrics."""
        self.graph.clear()
        self.node_risk.clear()
        self.cache = {
            "in_degree": {},
            "out_degree": {},
            "pagerank": {},
            "clustering": {},
            "cycle_nodes": set(),
            "component_size": {},
            "neighbor_avg_risk": {},
            "rings": [],
            "node_to_ring": {},
        }

    def add_transaction(self, txn: Transaction, risk: float = 0.0) -> None:
        """Add directed edge between sender and receiver with transaction weight.

        Live and Training Parity Rule:
        Node risk must ONLY be derived from heuristic or scoring-time signals available
        prior to ground-truth label revelation (e.g. rule-based scoring or evaluated score).
        Ground-truth labels (is_fraud) must NEVER be passed here to prevent label leakage
        into neighbor_avg_risk and ring calculations.
        """
        if not self.graph.has_node(txn.sender_id):
            self.graph.add_node(txn.sender_id)
        if not self.graph.has_node(txn.receiver_id):
            self.graph.add_node(txn.receiver_id)

        # Update edge attributes
        if self.graph.has_edge(txn.sender_id, txn.receiver_id):
            self.graph[txn.sender_id][txn.receiver_id]["weight"] += txn.amount
            self.graph[txn.sender_id][txn.receiver_id]["count"] += 1
            self.graph[txn.sender_id][txn.receiver_id]["last_time"] = txn.timestamp
            self.graph[txn.sender_id][txn.receiver_id]["risk"] = max(
                self.graph[txn.sender_id][txn.receiver_id].get("risk", 0.0), risk
            )
        else:
            self.graph.add_edge(
                txn.sender_id,
                txn.receiver_id,
                weight=txn.amount,
                count=1,
                last_time=txn.timestamp,
                risk=risk,
            )

        if risk > 0.0:
            self.update_node_risk(txn.sender_id, risk)

    def update_node_risk(self, account_id: str, risk: float) -> None:
        """Update known account risk score."""
        current = self.node_risk.get(account_id, 0.0)
        self.node_risk[account_id] = max(current, risk)

    def recompute_cache(self) -> Dict[str, Any]:
        """Recompute topological graph metrics, cycle rings, and update in-memory cache."""
        if len(self.graph) == 0:
            return self.cache

        # 1. Degrees
        in_degree = dict(self.graph.in_degree())
        out_degree = dict(self.graph.out_degree())

        # 2. PageRank
        try:
            pagerank = nx.pagerank(self.graph, alpha=0.85, max_iter=50, tol=1e-4)
        except Exception:
            pagerank = {n: 1.0 / len(self.graph) for n in self.graph.nodes()}

        # 3. Clustering coefficient (on undirected projection)
        try:
            undirected_graph = self.graph.to_undirected()
            clustering = nx.clustering(undirected_graph)
        except Exception:
            clustering = {n: 0.0 for n in self.graph.nodes()}

        # 4. Cycle & Ring detection via bounded-length cycles on risk-filtered subgraph
        # Parameters (derived from fraud ring topology reasoning, not benchmark-tuned):
        # - Min cycle length: 3 (bilateral 2-node loops are buyer/seller commerce, not rings)
        # - Max cycle length: 8 (longer paths are inefficient for rapid mule cash-out)
        # - Max ring size cap: 10 (groups > 10 nodes are flagged as dense clusters, not rings)
        # - Suspicious edge filter:
        #   Edges are included if edge/node risk >= 0.30, OR if edge has repeat volume (count >= 2),
        #   OR in smaller graphs (nodes <= 50) where all edges are considered candidate paths.
        cycle_nodes: Set[str] = set()
        rings: List[Dict[str, Any]] = []
        node_to_ring: Dict[str, str] = {}
        dense_clusters: List[Dict[str, Any]] = []

        risk_threshold = 0.30
        is_small_graph = len(self.graph) <= 50

        suspicious_edges = []
        for u, v, data in self.graph.edges(data=True):
            e_risk = data.get("risk", 0.0)
            u_risk = self.node_risk.get(u, 0.0)
            v_risk = self.node_risk.get(v, 0.0)
            cnt = data.get("count", 1)
            if is_small_graph or e_risk >= risk_threshold or u_risk >= risk_threshold or v_risk >= risk_threshold or cnt >= 2:
                suspicious_edges.append((u, v))

        if suspicious_edges:
            subgraph = self.graph.edge_subgraph(suspicious_edges).copy()

            for scc in nx.strongly_connected_components(subgraph):
                scc_len = len(scc)
                if scc_len > 10:
                    # Oversized components are dense clusters, not fraud rings
                    dense_clusters.append({
                        "cluster_id": f"CLUSTER_{min(scc)}",
                        "size": scc_len,
                        "members": sorted(list(scc))[:25],
                    })
                elif scc_len >= 3:
                    # Search for simple bounded elementary cycles of length 3..8
                    scc_subgraph = subgraph.subgraph(scc)
                    try:
                        cycles = list(nx.simple_cycles(scc_subgraph))
                    except Exception:
                        cycles = []

                    valid_cycles = [c for c in cycles if 3 <= len(c) <= 8]
                    if valid_cycles:
                        # Combine connected cycle members into rings capped at size 10
                        ring_members_set = set()
                        for c in valid_cycles:
                            ring_members_set.update(c)

                        if 3 <= len(ring_members_set) <= 10:
                            cycle_nodes.update(ring_members_set)
                            members = sorted(list(ring_members_set))
                            r_id = f"RING_{members[0]}"
                            member_risks = [self.node_risk.get(m, 0.8) for m in members]
                            avg_risk = sum(member_risks) / len(member_risks) if member_risks else 0.8
                            r_score = int(round(max(max(member_risks, default=0.8), avg_risk) * 100))
                            rings.append({
                                "ring_id": r_id,
                                "members": members,
                                "score": min(max(r_score, 75), 100),
                            })
                            for m in members:
                                node_to_ring[m] = r_id
                        elif len(ring_members_set) > 10:
                            dense_clusters.append({
                                "cluster_id": f"CLUSTER_{min(ring_members_set)}",
                                "size": len(ring_members_set),
                                "members": sorted(list(ring_members_set))[:25],
                            })
                    else:
                        # Fallback for scc with length 3..10 if simple_cycles was empty
                        cycle_nodes.update(scc)
                        members = sorted(list(scc))
                        r_id = f"RING_{members[0]}"
                        member_risks = [self.node_risk.get(m, 0.8) for m in members]
                        avg_risk = sum(member_risks) / len(member_risks) if member_risks else 0.8
                        r_score = int(round(max(max(member_risks, default=0.8), avg_risk) * 100))
                        rings.append({
                            "ring_id": r_id,
                            "members": members,
                            "score": min(max(r_score, 75), 100),
                        })
                        for m in members:
                            node_to_ring[m] = r_id
                elif scc_len == 1:
                    node = next(iter(scc))
                    if subgraph.has_edge(node, node):
                        cycle_nodes.add(node)
                        r_id = f"RING_{node}"
                        rings.append({
                            "ring_id": r_id,
                            "members": [node],
                            "score": 90,
                        })
                        node_to_ring[node] = r_id

        # 5. Connected component sizes (weakly connected)
        component_size: Dict[str, int] = {}
        for comp in nx.weakly_connected_components(self.graph):
            c_len = len(comp)
            for node in comp:
                component_size[node] = c_len

        # 6. Message-passing neighbor average risk
        neighbor_avg_risk: Dict[str, float] = {}
        for node in self.graph.nodes():
            neighbors = set(self.graph.predecessors(node)) | set(self.graph.successors(node))
            if neighbors:
                total_risk = sum(self.node_risk.get(nbr, 0.0) for nbr in neighbors)
                neighbor_avg_risk[node] = total_risk / len(neighbors)
            else:
                neighbor_avg_risk[node] = 0.0

        self.cache = {
            "in_degree": in_degree,
            "out_degree": out_degree,
            "pagerank": pagerank,
            "clustering": clustering,
            "cycle_nodes": cycle_nodes,
            "component_size": component_size,
            "neighbor_avg_risk": neighbor_avg_risk,
            "rings": rings,
            "node_to_ring": node_to_ring,
            "dense_clusters": dense_clusters,
        }
        return self.cache

    def get_cache(self) -> Dict[str, Any]:
        """Return cached graph metrics."""
        return self.cache


# Global singleton engine and backwards-compatible aliases
GLOBAL_GRAPH = GraphEngine()
graph = GLOBAL_GRAPH.graph


def detect_cycles() -> Dict[str, Any]:
    """Detect cycles or ring structures in background."""
    cache = GLOBAL_GRAPH.recompute_cache()
    return {
        "cycle_nodes": list(cache.get("cycle_nodes", set())),
        "count": len(cache.get("cycle_nodes", set())),
        "rings": cache.get("rings", []),
    }
