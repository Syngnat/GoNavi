package app

import (
	"math"

	"GoNavi-Wails/internal/connection"
)

// 实测计划的后处理：每一步的估算偏差，以及按实际耗时归属的热点。

// explainEstimateMinRows: a misestimate over fewer rows than this (summed over
// the step's loops) does not change the plan worth mentioning.
const explainEstimateMinRows = 100

// annotateExplainActuals marks a plan as measured, compares each executed
// step's actual rows with its estimate and re-attributes the hotspots to the
// time each step really took.
func annotateExplainActuals(result *connection.ExplainResult) {
	if result == nil {
		return
	}
	result.Analyzed = true
	for index := range result.Nodes {
		markExplainNeverExecuted(&result.Nodes[index])
		annotateExplainEstimate(&result.Nodes[index])
	}
	annotateExplainTimeHotspots(result)
}

// markExplainNeverExecuted tells a step the executor skipped (an inner side
// whose outer side produced nothing) from a grouping line that has no numbers
// of its own: only a real step carries an estimate.
func markExplainNeverExecuted(node *connection.ExplainNode) {
	if node.Loops > 0 || node.DurationMs > 0 || node.Extra[sqlServerNoRuntimeKey] == true {
		return
	}
	_, treeCost := node.Extra["estimatedTotalCost"]
	if node.EstRows > 0 || node.Cost > 0 || treeCost {
		setExplainExtra(node, "neverExecuted", true)
	}
}

// annotateExplainEstimate compares rows per loop, as every dialect reports
// both the estimate and the actual count per loop. Counts under one row are
// taken as one so that "0 vs 1" is not a misestimate.
func annotateExplainEstimate(node *connection.ExplainNode) {
	if node.Loops <= 0 || node.EstRows <= 0 {
		return
	}
	estimated := float64(node.EstRows)
	actual := math.Max(float64(node.ActualRows), 1)
	factor := actual / estimated
	node.EstimateFactor = factor
	volume := math.Max(estimated, float64(node.ActualRows)) * float64(node.Loops)
	if volume >= explainEstimateMinRows && (factor >= ruleEstimationSkewRatio || factor <= 1/ruleEstimationSkewRatio) {
		node.Flags = appendExplainFlag(node.Flags, connection.ExplainFlagUccWarn)
	}
}

// explainNodeTotalMs is the time a step took over all of its loops; dialects
// report the per-loop average.
func explainNodeTotalMs(node connection.ExplainNode) float64 {
	if node.DurationMs <= 0 {
		return 0
	}
	loops := node.Loops
	if loops < 1 {
		loops = 1
	}
	return node.DurationMs * float64(loops)
}

// annotateExplainTimeHotspots replaces the estimated hotspots with measured
// self time: a step's time minus the time of the steps under it. A step with
// no time of its own (MySQL's "Select #2" grouping line) passes on the time of
// the steps it groups, so its parent does not count that time as its own.
func annotateExplainTimeHotspots(result *connection.ExplainResult) {
	nodes := result.Nodes
	totals := make([]float64, len(nodes))
	measured := false
	for index, node := range nodes {
		totals[index] = explainNodeTotalMs(node)
		measured = measured || totals[index] > 0
	}
	if !measured {
		return
	}
	children := make(map[string][]int, len(nodes))
	for index, node := range nodes {
		if node.ParentID != "" {
			children[node.ParentID] = append(children[node.ParentID], index)
		}
	}
	subtree := make([]float64, len(nodes))
	resolved := make([]bool, len(nodes))
	var subtreeMs func(index int) float64
	subtreeMs = func(index int) float64 {
		if resolved[index] {
			return subtree[index]
		}
		resolved[index] = true
		value := totals[index]
		if value <= 0 {
			for _, child := range children[nodes[index].ID] {
				value += subtreeMs(child)
			}
		}
		subtree[index] = value
		return value
	}
	self := make([]float64, len(nodes))
	total := 0.0
	for index, node := range nodes {
		if totals[index] <= 0 {
			continue
		}
		value := totals[index]
		for _, child := range children[node.ID] {
			value -= subtreeMs(child)
		}
		self[index] = math.Max(0, value)
		total += self[index]
	}
	applyExplainHotspotShares(result, self, total, explainHotspotBasisTime)
}

// explainMeasuredWallMs is the statement's time when a dialect reports no total
// of its own: step times include the steps below them, so the largest one is
// the outermost measured step. Summing the steps would count children twice.
func explainMeasuredWallMs(nodes []connection.ExplainNode) float64 {
	wall := 0.0
	for _, node := range nodes {
		wall = math.Max(wall, explainNodeTotalMs(node))
	}
	return roundExplain(wall, 3)
}
