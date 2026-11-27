import React, { useEffect, useRef, useState, useMemo, useCallback } from 'react';
import ForceGraph2D, { ForceGraphMethods } from 'react-force-graph-2d';
import type { GraphNode, GraphEdge, DetectedRing } from '../types/fraud';

interface GraphCanvasProps {
  nodes: GraphNode[];
  edges: GraphEdge[];
  rings: DetectedRing[];
}

export const GraphCanvas: React.FC<GraphCanvasProps> = ({ nodes, edges, rings }) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const fgRef = useRef<ForceGraphMethods>();
  const [dimensions, setDimensions] = useState({ width: 600, height: 440 });
  const [hoveredNode, setHoveredNode] = useState<GraphNode | null>(null);
  const [tooltipPos, setTooltipPos] = useState<{ x: number; y: number } | null>(null);

  // Measure container dimensions
  useEffect(() => {
    const updateSize = () => {
      if (containerRef.current) {
        setDimensions({
          width: containerRef.current.clientWidth,
          height: Math.max(380, containerRef.current.clientHeight),
        });
      }
    };
    updateSize();
    window.addEventListener('resize', updateSize);
    return () => window.removeEventListener('resize', updateSize);
  }, []);

  // Stable graph data cache to prevent simulation restarts on poll
  const cachedNodesRef = useRef<Map<string, GraphNode>>(new Map());
  const prevRingCountRef = useRef<number>(0);

  const graphData = useMemo(() => {
    const currentNodes = cachedNodesRef.current;
    const reconciledNodes: GraphNode[] = [];

    // Reconcile nodes keeping x, y, vx, vy stable
    nodes.forEach((incoming) => {
      const existing = currentNodes.get(incoming.id);
      if (existing) {
        existing.risk = incoming.risk;
        existing.ring_id = incoming.ring_id;
        existing.txn_count = incoming.txn_count;
        reconciledNodes.push(existing);
      } else {
        const fresh = { ...incoming };
        currentNodes.set(fresh.id, fresh);
        reconciledNodes.push(fresh);
      }
    });

    // Reconcile edges
    const reconciledEdges = edges.map((e) => ({
      source: typeof e.source === 'object' ? (e.source as any).id : e.source,
      target: typeof e.target === 'object' ? (e.target as any).id : e.target,
      amount: e.amount,
      count: e.count,
    }));

    return { nodes: reconciledNodes, links: reconciledEdges };
  }, [nodes, edges]);

  // Zoom to fit once when a new ring appears
  useEffect(() => {
    if (rings.length > prevRingCountRef.current && fgRef.current) {
      setTimeout(() => {
        fgRef.current?.zoomToFit(500, 32);
      }, 300);
    }
    prevRingCountRef.current = rings.length;
  }, [rings.length]);

  // Node paint callback
  const paintNode = useCallback((node: any, ctx: CanvasRenderingContext2D, globalScale: number) => {
    const x = node.x || 0;
    const y = node.y || 0;
    const count = node.txn_count || 1;
    const radius = Math.max(4, Math.min(18, 4 + Math.sqrt(count) * 2));

    let fillColor = '#1E8E5A'; // allow
    if (node.risk >= 70) {
      fillColor = '#C0362C'; // block
    } else if (node.risk >= 40) {
      fillColor = '#B7791F'; // review
    }

    // Outer dark red ring outline for ring members
    if (node.ring_id) {
      ctx.beginPath();
      ctx.arc(x, y, radius + 3 / globalScale, 0, 2 * Math.PI, false);
      ctx.strokeStyle = '#991B1B';
      ctx.lineWidth = 2.5 / globalScale;
      ctx.stroke();
    }

    // Node body
    ctx.beginPath();
    ctx.arc(x, y, radius, 0, 2 * Math.PI, false);
    ctx.fillStyle = fillColor;
    ctx.fill();

    // Subtle edge boundary
    ctx.strokeStyle = '#FFFFFF';
    ctx.lineWidth = 1 / globalScale;
    ctx.stroke();
  }, []);

  // Link styling
  const getLinkColor = useCallback((link: any) => {
    const sId = typeof link.source === 'object' ? link.source.id : link.source;
    const tId = typeof link.target === 'object' ? link.target.id : link.target;
    const sNode = cachedNodesRef.current.get(sId);
    const tNode = cachedNodesRef.current.get(tId);

    if (sNode?.ring_id && tNode?.ring_id && sNode.ring_id === tNode.ring_id) {
      return '#C0362C'; // Red edge connecting ring members
    }
    return '#DCE0E7'; // Clean gray for standard relationships
  }, []);

  const getLinkWidth = useCallback((link: any) => {
    const sId = typeof link.source === 'object' ? link.source.id : link.source;
    const tId = typeof link.target === 'object' ? link.target.id : link.target;
    const sNode = cachedNodesRef.current.get(sId);
    const tNode = cachedNodesRef.current.get(tId);

    if (sNode?.ring_id && tNode?.ring_id && sNode.ring_id === tNode.ring_id) {
      return 2;
    }
    return Math.min(3, 1 + Math.log2((link.count || 1) + 1) * 0.4);
  }, []);

  const handleNodeHover = useCallback((node: any) => {
    if (node) {
      setHoveredNode(node);
      if (fgRef.current && node.x !== undefined && node.y !== undefined) {
        const coords = fgRef.current.graph2ScreenCoords(node.x, node.y);
        setTooltipPos({ x: coords.x, y: coords.y });
      }
    } else {
      setHoveredNode(null);
      setTooltipPos(null);
    }
  }, []);

  return (
    <div className="w-full bg-[#FFFFFF] border border-[#DCE0E7] rounded-[6px] p-4 flex flex-col relative">
      <div className="flex items-center justify-between pb-3 border-b border-[#DCE0E7] mb-2">
        <h2 className="text-[16px] font-medium text-[#1B2433]">Account network</h2>

        {/* Legend */}
        <div className="flex items-center space-x-4 text-[12px] text-[#5B6575]">
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#1E8E5A]" />
            <span>Allow</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#B7791F]" />
            <span>Review</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-2.5 h-2.5 rounded-full bg-[#C0362C]" />
            <span>Block</span>
          </div>
          <div className="flex items-center space-x-1.5">
            <span className="w-3 h-3 rounded-full border-2 border-[#991B1B] bg-transparent" />
            <span>Ring member</span>
          </div>
        </div>
      </div>

      {/* Canvas container */}
      <div ref={containerRef} className="w-full h-[460px] relative overflow-hidden bg-[#FFFFFF]">
        {graphData.nodes.length === 0 ? (
          <div className="w-full h-full flex items-center justify-center text-[13px] text-[#5B6575]">
            No network data available. Run a scenario to see account activity.
          </div>
        ) : (
          <ForceGraph2D
            ref={fgRef}
            width={dimensions.width}
            height={dimensions.height}
            graphData={graphData}
            nodeCanvasObject={paintNode}
            nodePointerAreaPaint={(node: any, color, ctx) => {
              const radius = Math.max(4, Math.min(18, 4 + Math.sqrt(node.txn_count || 1) * 2));
              ctx.beginPath();
              ctx.arc(node.x, node.y, radius + 2, 0, 2 * Math.PI, false);
              ctx.fillStyle = color;
              ctx.fill();
            }}
            linkColor={getLinkColor}
            linkWidth={getLinkWidth}
            linkDirectionalArrowLength={4}
            linkDirectionalArrowRelPos={1}
            linkDirectionalArrowColor={getLinkColor}
            onNodeHover={handleNodeHover}
            cooldownTicks={120}
            d3AlphaDecay={0.03}
            d3VelocityDecay={0.4}
            backgroundColor="#FFFFFF"
          />
        )}

        {/* Hover Tooltip */}
        {hoveredNode && tooltipPos && (
          <div
            className="absolute z-20 pointer-events-none bg-[#FFFFFF] border border-[#DCE0E7] rounded-[4px] p-2 text-[12px] shadow-sm transform -translate-x-1/2 -translate-y-full mb-2"
            style={{
              left: `${tooltipPos.x}px`,
              top: `${tooltipPos.y - 10}px`,
            }}
          >
            <div className="font-mono text-[#1B2433] font-medium">{hoveredNode.id}</div>
            <div className="text-[#5B6575] mt-0.5">
              Risk score: <span className="text-[#1B2433] tabular-nums font-medium">{hoveredNode.risk}</span>
            </div>
            <div className="text-[#5B6575]">
              Transactions: <span className="text-[#1B2433] tabular-nums font-medium">{hoveredNode.txn_count}</span>
            </div>
            {hoveredNode.ring_id && (
              <div className="text-[#C0362C] font-mono mt-0.5">
                Ring: {hoveredNode.ring_id}
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
};
