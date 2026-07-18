from nexus_api.planner import decompose_objective


def test_planner_is_deterministic_and_domain_sensitive() -> None:
    objective = "Explore a building with a robot, detect gas hazards, and create a 3D map."

    first = decompose_objective(objective)
    second = decompose_objective(objective)

    assert first == second
    categories = {requirement.category for requirement in first.requirements}
    assert {"mapping", "perception", "navigation", "safety"} <= categories
    assert any(task.requires_approval and task.risk == "critical" for task in first.tasks)
    assert any(component.name == "Digital Twin" for component in first.components)


def test_planner_keeps_minimum_safety_and_assurance_requirements() -> None:
    plan = decompose_objective("Build and validate a small environmental sensing station.")

    categories = {requirement.category for requirement in plan.requirements}
    assert {"mission", "safety", "assurance", "operations"} <= categories
    assert plan.tasks[-1].requires_approval is True
