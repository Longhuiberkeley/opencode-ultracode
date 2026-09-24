# Deliberate research with runtime loops

UltraCode runs independently of SpecFlow. `loop()` is a runtime primitive for
budgets, iteration, checkpoints and termination. A research loop is a bounded
investigation. A research cycle is the project's methodology; stage names such
as S1–S5 belong to the project, not the runtime API.

## Breadth before commitment

Start with the mission, constraints and observable success. Reason across the
plausible formulations before choosing a baseline: what assumptions do they
make, which alternatives do they expose, and how could we compare them?
Match this breadth to the uncertainty; a simple task needs no architecture
tournament. A decomposition is a working hypothesis, not a permanent boundary.

For ML, a curated-data/feature/model pipeline and an end-to-end model can be
competing formulations. For sensor fusion, preprocessing independent estimates
and combining them exposes different choices from jointly estimating a trajectory
with measurement constraints. Do not force both into the first decomposition.

Then choose the highest-value next investigation. Establish a credible baseline
and probe whether the data, measurement and evaluation can distinguish the
outcomes before expensive work. One experiment tests one coherent hypothesis;
it can involve coordinated component changes. Preserve comparable evaluation
conditions, and use fresh confirmation when adaptive search risks overfitting.

## Evidence and priority

A poor score can lower priority without falsifying an idea. State what was tested
and distinguish a scoped negative result from insufficient data, a defective
implementation, or an invalid instrument. Moving to a better-looking alternative
does not require proving the old one impossible. Record a concise reason and,
when useful, the evidence that would justify revisiting it.

An experiment earns continuation when it changes the next decision through new
evidence. Counts, category rotation and repeated claims of learning are insufficient.
Stay focused when evidence supports it; reconsider the formulation when its
assumptions or interfaces prevent useful progress. Budget or stall termination
ends the execution episode and makes no scientific claim about the whole idea.

## Execution and memory

Use one investigator per focused episode, deterministic logging and optional
recorder synthesis at natural boundaries. Independently check claims before they
become foundations or claimed successes. `agent()` creates a fresh session:
pass the mission, chosen formulation, baseline, recent evidence and next decision
explicitly between episodes. There is no persistent investigator-session API.

The `kaggle-ml` template requires formulation reasoning before generating trials.
Its `components` argument supplies suggestions, not an architectural constraint;
a joint formulation can be represented as a single component. It keeps the best
five trial scores plus a separate recent-six trial history and up to twelve
evidence-linked learnings in its result. Full diagnostics belong in candidate
artifacts. Thread these records into a later investigation when continuing work.

`metricDirection` is `max` by default or `min` for losses. Returned `best` scores
come from the independent judge; candidate scores remain explicitly provisional.
`bestResolved` retains the actual proposal text behind configuration IDs and
`bestArtifact` locates the implementation and evidence for continuation.
The final score must also satisfy the configured numeric target: agreement by
judge and skeptic cannot override that check. A contradictory termination is
returned as `blocked` with a `terminationIssue`, rather than claimed success.
Three rounds without a better verified score or a new judge-checked learning
stop with `stall`. A learning needs a question, finding, changed next decision
and matching candidate artifact reference. Duplicate claims or references do not
reset the counter. This is a bounded heuristic, not a proof of scientific novelty;
the judge must inspect the evidence. It does not label the approach falsified.

Generic `loop()` stall detection hashes the entire state. For other research
templates, use a substantive-progress `stop.predicate`; append-only logs and
counters otherwise keep changing that hash. Preserve the normal verdict and
skeptic checks on terminating claims.
