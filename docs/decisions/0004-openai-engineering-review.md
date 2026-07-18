# ADR 0004: Keep model-assisted engineering review read-only and evidence-bound

- Status: Accepted
- Date: 2026-07-16

## Context

NEXUS needs model-assisted reasoning to find gaps that fixed keyword rules may
miss, but its domain includes code, simulation, and future physical machines.
Sending model output directly to an executor or robot would collapse the
separation between proposal, evidence, approval, and authority that the control
plane is designed to enforce.

Model output must also be machine-readable, attributable, optional for local
development, and safe to disable without breaking the deterministic workflow.
Project objectives are user-controlled and may contain instructions that must
not override the review policy.

## Decision

NEXUS exposes an optional server-side OpenAI Engineering Review operation with
these boundaries:

1. The OpenAI Responses API receives a bounded projection of the current
   project and audit verification state.
2. The project evidence is explicitly treated as untrusted data, not as model
   instructions.
3. Structured Outputs constrain the response to a typed readiness assessment,
   concise findings, and one proposed next experiment.
4. The reviewer receives no tools, credentials other than its API access, shell,
   network destinations, database handle, approval capability, or robot command
   interface.
5. A review cannot change project state, approve an action, start a simulation,
   or send a hardware command.
6. Physical findings must remain recommendations that require human approval.
7. A successful call records provider/model provenance and input/output digests
   in the project's tamper-evident audit chain. Provider errors are sanitized
   before being returned to a client.
8. `OPENAI_API_KEY` is optional and server-side only. Without it, the endpoint
   reports that review is unavailable while deterministic planning and
   simulation continue normally.
9. The model identifier and timeout are configuration, not browser-controlled
   input.

The default model follows the current OpenAI recommendation for complex
reasoning, while remaining overridable so deployments can choose a different
cost/latency point without changing the safety boundary.

## Consequences

NEXUS can demonstrate genuine model-assisted engineering analysis while keeping
execution deterministic and human-controlled. Typed output makes the result
testable and easier to present in the dashboard. Audit digests make it possible
to establish which evidence was reviewed without placing an API secret in the
client.

The review is advisory and may still be incomplete or wrong. It does not replace
tests, simulation, domain experts, or a safety case. A deployment must budget
for model latency, provider failure, rate limits, and cost. Persisting and
versioning full review artifacts, running model evaluations, and adding
organization-level authorization remain future work.

## Rejected alternatives

- Letting the model call launch or approval functions was rejected because a
  language-model response is not an authorization decision.
- Replacing the deterministic objective planner was rejected because project
  creation and offline demos must remain reproducible and available without an
  external provider.
- Calling OpenAI directly from the browser was rejected because it would expose
  credentials and bypass the API's provenance and audit boundary.
- Free-form JSON was rejected because schema adherence and explicit enums are
  important for safe UI handling and regression tests.
