# Heroz Graph Builder — Agent Instructions

## Project Architecture

Heroz uses a hybrid MongoDB + Neo4j recommendation architecture.

MongoDB is the authoritative source of truth for:
- operational data
- behavioral evidence
- learned child knowledge
- parent constraints
- activities
- sessions
- vendors

Neo4j is used for:
- semantic relationships
- candidate discovery
- graph traversal

Neo4j must not become an independent source of operational truth.

## Component Responsibilities

### Graph Builder
Transforms approved MongoDB data into Neo4j nodes and relationships.

### D4 Graph Traversal Engine
Read-only candidate discovery.

D4:
- reads Neo4j
- discovers candidate activities
- preserves graph evidence
- does not score
- does not rank
- does not apply operational eligibility

### D5 Recommendation Engine
D5:
- consumes D4 candidates
- revalidates current MongoDB data
- applies hard eligibility
- calculates recommendation factors
- handles missing data
- calculates final scores
- ranks candidates
- returns Top-N recommendations

## Critical Rule

Hard constraints are evaluated before scoring.

A high recommendation score must never compensate for a failed hard constraint.

## Canonical Data Rule

Final Deliverable 2 MongoDB schema is authoritative.

Do not preserve temporary mock fields simply because existing code uses them.

When the current implementation conflicts with the finalized schema, update the implementation.

Do not invent missing schema fields.

If a required field cannot be identified, stop and report the issue instead of guessing.

## Recommendation Factors

Use exactly these V1 weights:

- Interest Relevance: 0.30
- Child Preference Match: 0.15
- Goal & Outcome Relevance: 0.15
- Exploration & Novelty: 0.12
- Previous Behavioral Affinity: 0.08
- Vendor Reliability: 0.08
- Session Suitability: 0.12

Do not introduce additional weighted recommendation factors.

## Missing Data

Missing data is not automatically negative evidence.

A factor with insufficient evidence must remain unavailable.

Unavailable factors are excluded from final scoring and remaining factor weights are renormalized.

A genuine score of 0.0 is different from an unavailable factor.

## Implementation Rules

- Keep changes small and incremental.
- Do not redesign unrelated parts of the system.
- Do not add dependencies unless necessary.
- Do not modify scoring formulas unless explicitly requested.
- Do not change MongoDB schemas without explicit instruction.
- Prefer existing project modules and architecture.
- Preserve evidence during candidate deduplication.
- Run relevant tests after every change.
- Report assumptions before implementing them.