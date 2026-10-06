package app

import (
	"math"

	"GoNavi-Wails/internal/connection"
)

// Hotspot bases: what a node's CostShare is a share of.
const (
	explainHotspotBasisCost = "cost"
	explainHotspotBasisRows = "rows"
	// explainHotspotBasisTime: measured self time of an analyzed plan.
	explainHotspotBasisTime = "time"
)

const (
	// explainHotspotTopShare flags the costliest step once it carries a real
	// part of the plan; explainHotspotShare flags any step that dominates.
	explainHotspotTopShare = 0.25
	explainHotspotShare    = 0.4
)

// explainCostIsCumulative reports whether a dialect's node cost includes its
// children (PostgreSQL "Total Cost", SQL Server subtree cost, DBMS_XPLAN cost).
// MySQL's classic JSON reports per-table read cost; its v2 tree format is
// detected from the node extras instead.
func explainCostIsCumulative(dbType string) bool {
	switch dbType {
	case "postgres", "gaussdb", "opengauss", "kingbase", "highgo", "vastbase",
		"oracle", "yashandb", "sqlserver", "cockroachdb", "kwdb":
		return true
	default:
		return false
	}
}

// annotateExplainHotspots attributes the plan's estimated work to the step that
// does it, so the reader is told "this step is 61% of the cost" instead of
// comparing cumulative subtree costs by eye. Without any cost, rows read by the
// access steps stand in for work. It also corrects Stats.TotalCost for
// cumulative dialects, where summing every node counts children repeatedly.
func annotateExplainHotspots(result *connection.ExplainResult, cumulative bool) {
	if result == nil || len(result.Nodes) == 0 {
		return
	}
	costs, mysqlTree := explainNodeCosts(result.Nodes)
	cumulative = cumulative || mysqlTree
	self := make([]float64, len(result.Nodes))
	total := 0.0
	basis := explainHotspotBasisCost
	if hasPositive(costs) {
		childCost := make(map[string]float64, len(result.Nodes))
		if cumulative {
			for index, node := range result.Nodes {
				if node.ParentID != "" {
					childCost[node.ParentID] += costs[index]
				}
			}
		}
		for index, node := range result.Nodes {
			value := costs[index]
			if cumulative {
				value -= childCost[node.ID]
			}
			self[index] = math.Max(0, value)
			total += self[index]
		}
		// The self costs of a cumulative plan add up to its root cost. MySQL's
		// tree parser already reports the root cost itself.
		if cumulative && !mysqlTree {
			result.Stats.TotalCost = roundExplain(total, 2)
		}
	} else {
		basis = explainHotspotBasisRows
		for index, node := range result.Nodes {
			if isExplainAccessOp(node.OpType) && node.EstRows > 0 {
				self[index] = float64(node.EstRows)
				total += self[index]
			}
		}
	}
	applyExplainHotspotShares(result, self, total, basis)
}

// applyExplainHotspotShares writes each step's share of the plan's work and
// flags the steps that dominate it. Earlier shares and flags are replaced, so a
// measured basis can supersede the estimated one.
func applyExplainHotspotShares(result *connection.ExplainResult, self []float64, total float64, basis string) {
	if total <= 0 {
		return
	}
	result.HotspotBasis = basis
	top := -1
	for index := range result.Nodes {
		result.Nodes[index].CostShare = 0
		result.Nodes[index].Flags = removeExplainFlags(result.Nodes[index].Flags, connection.ExplainFlagHighCost)
		share := self[index] / total
		if share <= 0 {
			continue
		}
		result.Nodes[index].CostShare = roundExplain(share, 4)
		if top < 0 || share > self[top]/total {
			top = index
		}
	}
	for index := range result.Nodes {
		share := result.Nodes[index].CostShare
		if share >= explainHotspotShare || (index == top && share >= explainHotspotTopShare) {
			result.Nodes[index].Flags = appendExplainFlag(result.Nodes[index].Flags, connection.ExplainFlagHighCost)
		}
	}
}

// explainNodeCosts returns each node's cost. MySQL's v2 tree keeps the
// cumulative cost of non-root nodes in extras; finding one marks the plan as
// cumulative.
func explainNodeCosts(nodes []connection.ExplainNode) ([]float64, bool) {
	costs := make([]float64, len(nodes))
	mysqlTree := false
	for index, node := range nodes {
		costs[index] = node.Cost
		if value, ok := node.Extra["estimatedTotalCost"].(float64); ok && value > 0 {
			mysqlTree = true
			if costs[index] == 0 {
				costs[index] = value
			}
		}
	}
	return costs, mysqlTree
}

func hasPositive(values []float64) bool {
	for _, value := range values {
		if value > 0 {
			return true
		}
	}
	return false
}

func isExplainAccessOp(opType string) bool {
	switch opType {
	case connection.ExplainOpScan, connection.ExplainOpIndexScan, connection.ExplainOpIndexOnly:
		return true
	default:
		return false
	}
}

func appendExplainFlag(flags []string, flag string) []string {
	for _, existing := range flags {
		if existing == flag {
			return flags
		}
	}
	return append(flags, flag)
}

func roundExplain(value float64, digits int) float64 {
	scale := math.Pow(10, float64(digits))
	return math.Round(value*scale) / scale
}
