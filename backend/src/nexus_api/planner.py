from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class RequirementPlan:
    title: str
    description: str
    category: str
    priority: str
    acceptance_criteria: str


@dataclass(frozen=True)
class ComponentPlan:
    name: str
    kind: str
    technology: str
    responsibility: str


@dataclass(frozen=True)
class TaskPlan:
    title: str
    description: str
    risk: str
    requires_approval: bool


@dataclass(frozen=True)
class EngineeringPlan:
    requirements: tuple[RequirementPlan, ...]
    components: tuple[ComponentPlan, ...]
    tasks: tuple[TaskPlan, ...]


def decompose_objective(objective: str) -> EngineeringPlan:
    """Create a deterministic, reviewable engineering plan without model calls.

    Keyword rules add domain detail, while the stable baseline keeps API behavior
    reproducible in tests and creates an explicit boundary for a future AI planner.
    """

    normalized = " ".join(objective.lower().split())
    mapping_requested = any(word in normalized for word in ("map", "mapping", "building"))
    hazards_requested = any(
        word in normalized for word in ("hazard", "danger", "smoke", "fire", "gas")
    )
    mobile_robot = any(word in normalized for word in ("robot", "rover", "drone", "explore"))

    requirements: list[RequirementPlan] = [
        RequirementPlan(
            "Mission objective and operating envelope",
            f'Deliver the objective: "{objective.strip()}" within a bounded, observable mission.',
            "mission",
            "must",
            "A simulation report records coverage, duration, task outcomes, and all safety events.",
        ),
        RequirementPlan(
            "Fail-safe operation",
            "Default to a stopped state on lost control, invalid plans, or "
            "emergency-stop activation.",
            "safety",
            "must",
            "Physical launch remains blocked until a named human approves it; "
            "emergency stop halts motion.",
        ),
        RequirementPlan(
            "Traceable decisions",
            "Record plans, approvals, state changes, and evidence in a tamper-evident audit chain.",
            "assurance",
            "must",
            "The audit verification endpoint validates every sequence and SHA-256 link.",
        ),
        RequirementPlan(
            "Live operational awareness",
            "Expose project, task, robot, and sensor state to the dashboard in near real time.",
            "operations",
            "should",
            "REST snapshots and WebSocket events agree on progress and robot safety state.",
        ),
    ]
    if mapping_requested:
        requirements.insert(
            1,
            RequirementPlan(
                "Metric 3D environment map",
                "Localize throughout the mission and build a spatial map with coverage evidence.",
                "mapping",
                "must",
                "Simulation achieves at least 90% mapped coverage and publishes "
                "a map artifact reference.",
            ),
        )
    if hazards_requested:
        requirements.insert(
            2,
            RequirementPlan(
                "Hazard detection and geolocation",
                "Detect candidate hazards, attach confidence and pose, and retain "
                "supporting evidence.",
                "perception",
                "must",
                "Known simulated hazards are reported with location and confidence "
                "without unsafe approach.",
            ),
        )
    if mobile_robot:
        requirements.append(
            RequirementPlan(
                "Collision-aware autonomous navigation",
                "Plan traversable paths while maintaining clearance from people and obstacles.",
                "navigation",
                "must",
                "The digital twin completes the route without collision or "
                "safety-boundary violation.",
            )
        )

    components = (
        ComponentPlan(
            "Mission Control API",
            "control-plane",
            "Python / FastAPI / PostgreSQL",
            "Own objectives, plans, approvals, telemetry, events, and the audit trail.",
        ),
        ComponentPlan(
            "Safety Supervisor",
            "safety-boundary",
            "Python policy engine",
            "Enforce approval gates, emergency stop, and deny-by-default physical adapters.",
        ),
        ComponentPlan(
            "Autonomy Stack",
            "robot-runtime",
            "ROS 2 / C++",
            "Perform localization, navigation, collision avoidance, and robot state publication.",
        ),
        ComponentPlan(
            "Perception Pipeline",
            "sensor-processing",
            "Python / OpenCV",
            "Fuse camera and environmental sensors into located hazard observations.",
        ),
        ComponentPlan(
            "Digital Twin",
            "simulation",
            "Gazebo",
            "Validate missions and failure behavior before any physical deployment is considered.",
        ),
        ComponentPlan(
            "Operator Dashboard",
            "human-interface",
            "TypeScript / React / WebSockets",
            "Present evidence, live state, approvals, and prominent emergency controls.",
        ),
    )

    tasks = (
        TaskPlan(
            "Formalize mission envelope",
            "Convert the objective into measurable requirements and bounded operating assumptions.",
            "low",
            False,
        ),
        TaskPlan(
            "Assemble digital twin",
            "Configure the robot, building, sensors, hazards, and repeatable scenario fixtures.",
            "medium",
            False,
        ),
        TaskPlan(
            "Integrate mapping and perception",
            "Connect localization, mapping, navigation, and hazard observations with telemetry.",
            "medium",
            False,
        ),
        TaskPlan(
            "Run safety-qualified simulation",
            "Exercise nominal and failure paths, recording evidence and acceptance results.",
            "high",
            False,
        ),
        TaskPlan(
            "Prepare physical deployment",
            "Review evidence and stage a hardware deployment without issuing device commands.",
            "critical",
            True,
        ),
    )
    return EngineeringPlan(tuple(requirements), components, tasks)
