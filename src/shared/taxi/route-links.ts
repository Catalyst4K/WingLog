/**
 * The links between cleared taxiways that a clearance leaves out (winglog-backend's docs/plans/taxi-routing-rules.md): a short
 * stretch of other taxiways from one cleared taxiway to the next, as route-search.ts prices them.
 */
import { itemAt } from '@shared/item-at'
import { MinQueue } from './min-queue'
import type { Graph } from './route-graph'

/** The longest stretch of uncleared named taxiways that counts as a link between two cleared ones; unnamed segments (junction fillets,
 *  runway crossings) don't count towards it: VHHH flight 253's way from F7's hold short to A crosses runway 07C on 138 m of unnamed
 *  path before the A10 and A11 links. The links in Callum's taxis driven as
 *  cleared were 34-240 m (VHHH's F8 and A12 together the longest); a parallel taxiway driven instead of the cleared one is longer
 *  (VHHH flight 243's B7, 848 m). */
export const LINK_MAX_M = 300

/**
 * @param graph The graph.
 * @param a One end of an edge.
 * @param b The other.
 * @returns The edge's key, the same either way round.
 */
export function edgeKey(graph: Graph, a: number, b: number): number {
  return Math.min(a, b) * graph.nodes.length + Math.max(a, b)
}

/**
 * The named edges of every link from one cleared taxiway to the next: those on a way between the two over other segments, with
 * LINK_MAX_M of named taxiway at most. With no next taxiway, every named edge that far from the first.
 *
 * @param graph The graph.
 * @param from The taxiway the link leaves.
 * @param to The taxiway it reaches, or null for any way out from `from`.
 * @returns The links' edges, by edgeKey.
 */
export function linksBetween(graph: Graph, from: string, to: string | null): Set<number> {
  const fromFrom = distancesOff(graph, from, from, to)
  const toTo = to === null ? null : distancesOff(graph, to, from, to)
  const links = new Set<number>()
  for (const [node, before] of fromFrom) {
    for (const edge of itemAt(graph.edges, node, 'taxi node')) {
      if (edge.name === null || edge.name === from || edge.name === to) continue
      const after = toTo ? toTo.get(edge.to) : 0
      if (after !== undefined && before + edge.lengthM + after <= LINK_MAX_M)
        links.add(edgeKey(graph, node, edge.to))
    }
  }
  return links
}

/**
 * How far each node is from a taxiway in named taxiway, up to LINK_MAX_M, over segments of neither cleared taxiway.
 *
 * @param graph The graph.
 * @param source The taxiway measured from: every node on it is at 0.
 * @param from The link's first taxiway.
 * @param to Its second, or null.
 * @returns Each reached node's distance.
 */
function distancesOff(graph: Graph, source: string, from: string, to: string | null): Map<number, number> {
  const distance = new Map<number, number>()
  const queue = new MinQueue()
  for (const [i] of graph.nodes.entries())
    if (itemAt(graph.edges, i, 'taxi node').some((e) => e.name === source)) {
      distance.set(i, 0)
      queue.push(i, 0)
    }
  while (queue.size > 0) {
    const [node, d] = queue.pop()
    if (d > (distance.get(node) ?? Infinity)) continue
    for (const edge of itemAt(graph.edges, node, 'taxi node')) {
      if (edge.name === from || edge.name === to) continue
      const next = d + (edge.name === null ? 0 : edge.lengthM)
      if (next > LINK_MAX_M || next >= (distance.get(edge.to) ?? Infinity)) continue
      distance.set(edge.to, next)
      queue.push(edge.to, next)
    }
  }
  return distance
}
