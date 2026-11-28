"""Amazon Neptune Gremlin Bulk-Loader CSV Exporter.

OVERVIEW:
This script exports the FraudShield account interaction graph into Amazon Neptune's
bulk-load CSV format for Gremlin property graphs.

NEPTUNE GREMLIN CSV FORMAT SPECIFICATION:
Amazon Neptune's bulk loader requires separate CSV files for vertices and edges
using reserved column header prefixes:
- Vertices CSV (vertices.csv):
    * ~id       : Unique identifier string for each vertex (e.g. account ID).
    * ~label    : Vertex type/label ("Account").
    * risk      : Overall fraud risk score (integer [0-100]).
    * ring_id   : Detected fraud ring identifier or empty string if not in a ring.
    * txn_count : Total transactions associated with this account.

- Edges CSV (edges.csv):
    * ~id       : Unique edge identifier string (e.g. "e_{source}_{target}").
    * ~from     : Source vertex ID (~id of sending Account).
    * ~to       : Target vertex ID (~id of receiving Account).
    * ~label    : Edge relationship label ("PAID").
    * amount    : Total aggregated transaction amount routed along this directed edge.
    * count     : Total transaction count between source and target accounts.

NEPTUNE BULK LOAD INSTRUCTIONS (AWS CLI / CURL):
1. Copy exported CSVs to an Amazon S3 bucket within the same AWS region as your Neptune cluster:
     aws s3 cp docs/neptune/vertices.csv s3://<your-neptune-bucket>/neptune-load/
     aws s3 cp docs/neptune/edges.csv s3://<your-neptune-bucket>/neptune-load/

2. Trigger the Neptune Bulk Loader API:
     curl -X POST https://<neptune-cluster-endpoint>:8182/loader \\
       -H 'Content-Type: application/json' \\
       -d '{
             "source" : "s3://<your-neptune-bucket>/neptune-load/",
             "format" : "csv",
             "iamRoleArn" : "arn:aws:iam::<account-id>:role/<NeptuneLoadRole>",
             "region" : "<aws-region>",
             "failOnError" : "FALSE",
             "parallelism" : "MEDIUM"
           }'

3. Query loader status via:
     curl https://<neptune-cluster-endpoint>:8182/loader/<load-job-id>
"""

import argparse
import csv
import json
import os
import sys
import urllib.error
import urllib.request
from pathlib import Path
from typing import Any, Dict, List, Optional, Tuple

# Ensure backend root is on sys.path for direct imports
BACKEND_ROOT = Path(__file__).resolve().parent.parent
if str(BACKEND_ROOT) not in sys.path:
    sys.path.insert(0, str(BACKEND_ROOT))

DEFAULT_OUTPUT_DIR = BACKEND_ROOT.parent / "docs" / "neptune"
DEFAULT_API_URL = "http://localhost:8000/graph"


def fetch_graph_from_api(api_url: str = DEFAULT_API_URL, timeout: float = 2.0) -> Optional[Dict[str, Any]]:
    """Attempt to fetch live graph topology from running FastAPI instance."""
    try:
        req = urllib.request.Request(api_url, headers={"Accept": "application/json"})
        with urllib.request.urlopen(req, timeout=timeout) as response:
            if response.status == 200:
                return json.loads(response.read().decode("utf-8"))
    except Exception:
        pass
    return None


def fetch_graph_from_engine() -> Dict[str, Any]:
    """Extract graph directly from in-memory engine and metrics."""
    try:
        from app.main import get_graph
        return get_graph()
    except Exception:
        pass

    try:
        from app.graph_engine import GLOBAL_GRAPH
        from app.metrics import METRICS
        recent = METRICS.get_recent_scored_transactions()
        cache = GLOBAL_GRAPH.get_cache()
        node_to_ring = cache.get("node_to_ring", {})
        nodes_map: Dict[str, Dict[str, Any]] = {}
        edges_map: Dict[Tuple[str, str], Dict[str, Any]] = {}

        for txn in recent:
            s_id = txn.sender_id
            r_id = txn.receiver_id

            if s_id not in nodes_map:
                nodes_map[s_id] = {
                    "id": s_id,
                    "risk": txn.risk_score,
                    "ring_id": txn.ring_id or node_to_ring.get(s_id, ""),
                    "txn_count": 0,
                }
            else:
                nodes_map[s_id]["risk"] = max(nodes_map[s_id]["risk"], txn.risk_score)
                if not nodes_map[s_id]["ring_id"]:
                    nodes_map[s_id]["ring_id"] = txn.ring_id or node_to_ring.get(s_id, "")
            nodes_map[s_id]["txn_count"] += 1

            if r_id not in nodes_map:
                nodes_map[r_id] = {
                    "id": r_id,
                    "risk": 0,
                    "ring_id": node_to_ring.get(r_id, ""),
                    "txn_count": 0,
                }
            nodes_map[r_id]["txn_count"] += 1

            edge_key = (s_id, r_id)
            if edge_key not in edges_map:
                edges_map[edge_key] = {"source": s_id, "target": r_id, "amount": 0.0, "count": 0}
            edges_map[edge_key]["amount"] = round(edges_map[edge_key]["amount"] + txn.amount, 2)
            edges_map[edge_key]["count"] += 1

        return {
            "nodes": list(nodes_map.values()),
            "edges": list(edges_map.values()),
            "rings": cache.get("rings", []),
        }
    except Exception:
        return {"nodes": [], "edges": [], "rings": []}


def get_graph_data(api_url: str = DEFAULT_API_URL) -> Dict[str, Any]:
    """Retrieve graph data trying live API first, falling back to in-memory engine."""
    data = fetch_graph_from_api(api_url)
    if data and "nodes" in data and "edges" in data:
        return data
    return fetch_graph_from_engine()


def export_neptune_csv(graph_data: Dict[str, Any], output_dir: Path) -> Tuple[Path, Path]:
    """Write vertices.csv and edges.csv matching Amazon Neptune bulk loader format."""
    output_dir.mkdir(parents=True, exist_ok=True)
    vertices_path = output_dir / "vertices.csv"
    edges_path = output_dir / "edges.csv"

    nodes = graph_data.get("nodes", [])
    edges = graph_data.get("edges", [])

    # 1. Export vertices.csv: ~id, ~label, risk, ring_id, txn_count
    with open(vertices_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["~id", "~label", "risk", "ring_id", "txn_count"])
        for node in nodes:
            writer.writerow([
                str(node.get("id", "")),
                "Account",
                int(node.get("risk", 0)),
                str(node.get("ring_id") or ""),
                int(node.get("txn_count", 0)),
            ])

    # 2. Export edges.csv: ~id, ~from, ~to, ~label, amount, count
    with open(edges_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(["~id", "~from", "~to", "~label", "amount", "count"])
        for idx, edge in enumerate(edges):
            src = str(edge.get("source", ""))
            tgt = str(edge.get("target", ""))
            edge_id = f"e_{src}_{tgt}" if src and tgt else f"e_{idx}"
            writer.writerow([
                edge_id,
                src,
                tgt,
                "PAID",
                float(edge.get("amount", 0.0)),
                int(edge.get("count", 0)),
            ])

    return vertices_path, edges_path


def main() -> None:
    parser = argparse.ArgumentParser(description="Export graph data to Amazon Neptune Gremlin bulk loader CSV format.")
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=DEFAULT_OUTPUT_DIR,
        help="Target directory for vertices.csv and edges.csv (default: docs/neptune/)",
    )
    parser.add_argument(
        "--api-url",
        type=str,
        default=DEFAULT_API_URL,
        help="FastAPI /graph endpoint URL (default: http://localhost:8000/graph)",
    )
    args = parser.parse_args()

    graph_data = get_graph_data(args.api_url)
    nodes_count = len(graph_data.get("nodes", []))
    edges_count = len(graph_data.get("edges", []))

    v_path, e_path = export_neptune_csv(graph_data, args.output_dir)
    print(f"Exported Neptune CSV files to {args.output_dir}:")
    print(f"  - {v_path.name}: {nodes_count} vertices")
    print(f"  - {e_path.name}: {edges_count} edges")


if __name__ == "__main__":
    main()
