import { useCallback, useEffect, useMemo, useRef } from 'react'
import ReactFlow, {
  Background,
  BackgroundVariant,
  Controls,
  MiniMap,
  type Edge,
  type Node,
  Position,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  useReactFlow,
} from 'reactflow'
import dagre from 'dagre'
import 'reactflow/dist/style.css'
import './ExplainAnalysis.css'
import type { ExplainEdge, ExplainNode } from '../../utils/explainTypes'
import { useI18n } from '../../i18n/provider'
import { ExplainGraphNodeRenderer, type ExplainGraphNodeData } from './ExplainGraphNode'
import { explainActualRows } from './explainActuals'
import {
  explainEdgeWidth,
  explainHotPath,
  formatCompactRows,
  type ExplainLayoutDirection,
} from './explainPlanInsights'

export type { ExplainGraphNodeData } from './ExplainGraphNode'

const NODE_WIDTH = 240
const NODE_HEIGHT = 146
/** Past this many steps a minimap is the only way to keep one's bearings. */
const MINIMAP_NODE_COUNT = 15

interface ExplainGraphProps {
  nodes: ExplainNode[]
  edges: ExplainEdge[]
  selectedNodeId?: string
  onSelectNode?: (nodeId: string | null) => void
  /** TB: result on top, scans at the bottom. LR: scans on the left, data flowing right to the result. */
  direction?: ExplainLayoutDirection
  /** The plan was measured: nodes show actual rows and time, edges the rows really handed up. */
  analyzed?: boolean
}

export default function ExplainGraph(props: ExplainGraphProps) {
  return (
    <ReactFlowProvider>
      <ExplainGraphInner {...props} />
    </ReactFlowProvider>
  )
}

function ExplainGraphInner({ nodes, edges, selectedNodeId, onSelectNode, direction = 'TB', analyzed }: ExplainGraphProps) {
  const { language, t } = useI18n()
  // Selection is deliberately excluded: highlighting a node must not run dagre again.
  const { rfNodes, rfEdges } = useMemo(() => {
    const layout = layoutWithDagre(nodes, edges, direction)
    const hotPath = explainHotPath(nodes)
    return {
      rfNodes: layout.rfNodes.map((node) => ({
        ...node,
        data: { ...node.data, direction, onHotPath: hotPath.has(node.id), analyzed },
      })),
      rfEdges: decorateExplainEdges(layout.rfEdges, nodes, hotPath, (rows) => (
        t('sql_analysis.explain_graph.edge.rows', { rows: formatCompactRows(rows, language) })
      ), analyzed),
    }
  }, [analyzed, direction, edges, language, nodes, t])

  const [nodeState, setNodeState, onNodesChange] = useNodesState(
    applyGraphNodeState(rfNodes, selectedNodeId, onSelectNode),
  )
  const [edgeState, setEdgeState, onEdgesChange] = useEdgesState(rfEdges)

  // useNodesState/useEdgesState only consume their initial value. Keep controlled
  // ReactFlow state in sync when an asynchronously loaded plan replaces the props.
  useEffect(() => {
    setNodeState(applyGraphNodeState(rfNodes, selectedNodeId, onSelectNode))
  }, [onSelectNode, rfNodes, selectedNodeId, setNodeState])

  useEffect(() => {
    setEdgeState(rfEdges)
  }, [rfEdges, setEdgeState])

  const handlePaneClick = useCallback(() => {
    onSelectNode?.(null)
  }, [onSelectNode])

  // Switching direction moves every node; the viewport has to follow once the
  // new positions are in the store, which is one render after the direction
  // changes. Selecting a node keeps the user's zoom.
  const { fitView } = useReactFlow()
  const fittedLayoutRef = useRef(direction)
  const renderedDirection = nodeState[0]?.data?.direction
  useEffect(() => {
    if (renderedDirection !== direction || fittedLayoutRef.current === direction) return undefined
    const frame = requestAnimationFrame(() => {
      fittedLayoutRef.current = direction
      fitView({ padding: 0.2, duration: 200 })
    })
    return () => cancelAnimationFrame(frame)
  }, [direction, fitView, renderedDirection])

  return (
    <div className="gn-explain-graph">
      <ReactFlow
        nodes={nodeState}
        edges={edgeState}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onPaneClick={handlePaneClick}
        nodeTypes={EXPLAIN_NODE_TYPES}
        fitView
        fitViewOptions={{ padding: 0.2 }}
        minZoom={0.2}
        proOptions={{ hideAttribution: true }}
      >
        <Background variant={BackgroundVariant.Dots} gap={16} size={1} />
        <Controls showInteractive={false} />
        {nodes.length > MINIMAP_NODE_COUNT ? <MiniMap pannable zoomable className="gn-explain-minimap" /> : null}
      </ReactFlow>
    </div>
  )
}

// layoutWithDagre only owns topology and positions. Interactive state is applied
// afterwards so selection and callback changes do not trigger an expensive layout.
export function layoutWithDagre(
  nodes: ExplainNode[],
  edges: ExplainEdge[],
  direction: ExplainLayoutDirection = 'TB',
): { rfNodes: Node<ExplainGraphNodeData>[]; rfEdges: Edge[] } {
  const horizontal = direction === 'LR'
  const graph = new dagre.graphlib.Graph()
  // Horizontal plans put the result on the right so data reads left to right.
  graph.setGraph({
    rankdir: horizontal ? 'RL' : 'TB',
    nodesep: horizontal ? 24 : 40,
    ranksep: horizontal ? 90 : 60,
    marginx: 20,
    marginy: 20,
  })
  graph.setDefaultEdgeLabel(() => ({}))

  for (const node of nodes) {
    graph.setNode(node.id, { width: NODE_WIDTH, height: NODE_HEIGHT })
  }
  for (const edge of edges) {
    graph.setEdge(edge.from, edge.to, { label: edge.label })
  }
  dagre.layout(graph)

  const rfNodes: Node<ExplainGraphNodeData>[] = nodes.map((node) => {
    const position = graph.node(node.id)
    return {
      id: node.id,
      type: 'explain',
      position: {
        x: (position?.x ?? 0) - NODE_WIDTH / 2,
        y: (position?.y ?? 0) - NODE_HEIGHT / 2,
      },
      data: { node, isSelected: false, direction },
      targetPosition: horizontal ? Position.Right : Position.Top,
      sourcePosition: horizontal ? Position.Left : Position.Bottom,
      draggable: false,
      selectable: false,
      focusable: false,
    }
  })

  const rfEdges: Edge[] = edges.map((edge, index) => ({
    id: `e-${edge.from}-${edge.to}-${index}`,
    source: edge.from,
    target: edge.to,
    label: edge.label,
    type: 'smoothstep',
    style: { stroke: 'var(--gn-fg-5)', strokeWidth: 1.5 },
  }))

  return { rfNodes, rfEdges }
}

/**
 * An edge carries the child's rows up to its parent: draw it as wide as that
 * flow (log scale) and say how many rows it is; the chain feeding the costliest
 * step is drawn in the danger color.
 */
export function decorateExplainEdges(
  edges: Edge[],
  nodes: ExplainNode[],
  hotPath: Set<string>,
  formatRows: (rows: number) => string,
  analyzed?: boolean,
): Edge[] {
  const byId = new Map(nodes.map((node) => [node.id, node]))
  // MySQL reports per-lookup rows; the rows a step hands up are in extra.rowsProduced.
  // A measured step reports rows per loop, so it hands up rows times loops.
  const rowsOf = (node?: ExplainNode) => {
    if (analyzed && node && (node.loops ?? 0) > 0) {
      return (explainActualRows(node, true) ?? 0) * (node.loops ?? 1)
    }
    const produced = node?.extra?.rowsProduced
    return typeof produced === 'number' ? produced : (node?.actualRows ?? node?.estRows)
  }
  const maxRows = nodes.reduce((max, node) => Math.max(max, rowsOf(node) ?? 0), 0)
  return edges.map((edge) => {
    const child = byId.get(edge.target)
    const rows = rowsOf(child)
    const hot = hotPath.has(edge.source) && hotPath.has(edge.target)
    const label = [edge.label, rows ? formatRows(rows) : ''].filter(Boolean).join(' · ')
    return {
      ...edge,
      label: label || undefined,
      labelBgPadding: [4, 2] as [number, number],
      labelBgBorderRadius: 4,
      className: hot ? 'gn-explain-edge gn-explain-edge--hot' : 'gn-explain-edge',
      style: {
        stroke: hot ? 'var(--gn-danger)' : 'var(--gn-fg-5)',
        strokeWidth: explainEdgeWidth(rows, maxRows),
      },
    }
  })
}

export function applyGraphNodeState(
  nodes: Node<ExplainGraphNodeData>[],
  selectedNodeId?: string,
  onSelectNode?: (nodeId: string | null) => void,
): Node<ExplainGraphNodeData>[] {
  return nodes.map((node) => ({
    ...node,
    data: {
      ...node.data,
      isSelected: node.id === selectedNodeId,
      onSelect: onSelectNode,
    },
  }))
}

const EXPLAIN_NODE_TYPES = { explain: ExplainGraphNodeRenderer }
