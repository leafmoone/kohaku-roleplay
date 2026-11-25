"""Latest-scene variants and isolated prose edits for the Novel Reader."""

import json
from typing import Literal
from uuid import uuid4

from kohakuterrarium.llm.base import fork_llm
from kohakuterrarium.llm.message import SystemMessage, UserMessage
from kohakuterrarium.terrarium.tools.context import (
    resolve_group_context,
    resolve_group_target,
)
from pydantic import Field, ValidationError

from .novel import (
    Chapter,
    CharacterSheet,
    Key,
    Scene,
    SceneError,
    Story,
    StoryModel,
    actor_memory,
    split_choices,
    story_chapters,
)

LEDGER = "novelRevision"
VARIANT_INPUTS = "novelRevisionVariantInputs"
BASELINE = "novelRevisionBaseline"
RUN = "novelRevisionRun"
PLAYER_INPUT = "novelLastPlayerInput"
REVISION_ACTIONS = {"suggest_span_rewrite", "apply_span_edit", "rewrite_latest_scene", "select_scene_variant"}


class SceneVariant(StoryModel):
    id: str
    mode: Literal["initial", "director_rewrite", "full_rerun", "inline_edit"]
    instruction: str = ""
    story: Story


class RevisionLedger(StoryModel):
    sceneNumber: int = Field(ge=1)
    baseline: Story
    dispatchedScene: Scene | None = None
    lastPlayerInput: str = ""
    activeIndex: int = 0
    variants: list[SceneVariant] = Field(default_factory=list)


class VariantInput(StoryModel):
    dispatchedScene: Scene | None
    lastPlayerInput: str


class ActiveRevision(StoryModel):
    mode: Literal["director_rewrite", "full_rerun"]
    instruction: str


class Span(StoryModel):
    number: int = Field(ge=0)
    start: int = Field(ge=0)
    end: int = Field(gt=0)


class SpanSuggestion(Span):
    selectedText: Key
    preset: Literal["expand", "concise", "in_character", "vivid", ""] = ""
    instruction: str = ""
    count: int = Field(default=2, ge=1, le=3)


class SpanEdit(Span):
    expectedText: Key
    replacementText: str


class Candidates(StoryModel):
    candidates: list[str]


class Rewrite(StoryModel):
    mode: Literal["director_only", "full_rerun"]
    instruction: str = ""
    playerInput: str = ""


class VariantSelection(StoryModel):
    index: int = Field(ge=0)


def ledger_for(binding) -> RevisionLedger | None:
    raw = binding.get_state(LEDGER)
    return RevisionLedger.model_validate(raw) if raw is not None else None


def active_revision(binding) -> ActiveRevision | None:
    raw = binding.get_state(RUN)
    return ActiveRevision.model_validate(raw) if raw is not None else None


def revision_view(host, story: Story, processing: bool) -> dict[str, object] | None:
    ledger = ledger_for(host.binding)
    if ledger is None:
        return None
    ready = not processing and story.pending is None and ledger.sceneNumber == story.completed and active_revision(host.binding) is None
    return {"sceneNumber": ledger.sceneNumber, "canDirectorRewrite": ready, "canFullRerun": ready,
            "hasCachedReports": ledger.dispatchedScene is not None, "lastPlayerInput": ledger.lastPlayerInput,
            "activeIndex": ledger.activeIndex, "variantCount": len(ledger.variants),
            "variants": [{"index": i, **variant.model_dump(exclude={"story"})} for i, variant in enumerate(ledger.variants)]}


def committed_revision(binding, before: Story, final: Story) -> dict[str, object]:
    run = active_revision(binding)
    if run:
        ledger = ledger_for(binding)
        if ledger is None or final.completed != ledger.sceneNumber:
            raise SceneError("This adjudication does not match the active scene rewrite")
        stored_inputs = binding.get_state(VARIANT_INPUTS) or {}
    else:
        captured = binding.get_state(BASELINE) if before.pending else None
        baseline = Story.model_validate(captured) if captured is not None else before.model_copy(update={"pending": None})
        ledger = RevisionLedger(sceneNumber=final.completed, baseline=baseline, lastPlayerInput=binding.get_state(PLAYER_INPUT) or "")
        stored_inputs = {}
    variant = SceneVariant(id=uuid4().hex, mode=run.mode if run else "initial", instruction=run.instruction if run else "", story=final)
    variants = [*ledger.variants, variant][-6:]
    # Keep the selected variant's proposals paired with the input that produced them.
    inputs = {item.id: stored_inputs[item.id] for item in variants if item.id in stored_inputs}
    inputs[variant.id] = VariantInput(dispatchedScene=before.pending, lastPlayerInput=ledger.lastPlayerInput).model_dump()
    ledger = ledger.model_copy(update={"variants": variants, "activeIndex": len(variants) - 1, "dispatchedScene": before.pending})
    return {LEDGER: ledger.model_dump(), VARIANT_INPUTS: inputs, RUN: None, BASELINE: None}


def variant_id(binding) -> str | None:
    ledger = ledger_for(binding)
    return ledger.variants[ledger.activeIndex].id if ledger and ledger.variants else None


def sync_story_to_cast(host, target_story: Story, reset_scene_markers_above: int | None = None,
                       *, metadata: dict[str, object] | None = None) -> None:
    binding = host.binding
    store = binding.session_store
    group = resolve_group_context(binding.host_agent.executor._build_tool_context())
    rows = [(binding._state_key(key), value) for key, value in {"novel": target_story.model_dump(), **(metadata or {})}.items()]
    children = []
    for actor in target_story.cast:
        node = resolve_group_target(group, actor).agent.plugins.get_plugin("roleplay")
        child = node.binding if node and node.mode == "npc" else None
        if child is None or child.session_store is not store or child.agent_name != actor:
            raise SceneError(f"Cannot restore state for NPC {actor!r} in this novel")
        values = {"privateKnowledge": actor_memory(target_story, actor).model_dump(),
                  "characterSheet": target_story.sheets.get(actor, CharacterSheet()).model_dump(),
                  "fieldValues": target_story.card_values.get(actor, {})}
        if reset_scene_markers_above is not None:
            for key in ("cueScene", "reportedScene"):
                marker = child.get_state(key)
                if type(marker) is int:
                    values[key] = min(marker, reset_scene_markers_above)
        rows.extend((child._state_key(key), value) for key, value in values.items())
        children.append(node)
    store.state.put_many(rows)
    for child in children:
        child.ui_emit("state", child.ui_state())


def _emit(host) -> dict[str, object]:
    view = host.ui_state()
    host.ui_emit("state", view)
    return view


def _span(story: Story, request: Span, expected: str) -> tuple[Chapter, str]:
    chapter = next((item for item in story_chapters(story) if item.number == request.number), None)
    if chapter is None:
        raise SceneError("The requested chapter is not in this novel")
    clean, _ = split_choices(chapter.prose)
    if not request.start < request.end <= len(clean) or clean[request.start:request.end] != expected:
        raise SceneError("The selected text no longer matches the chapter; select it again")
    return chapter, clean


async def _suggest(host, chapter: Chapter, clean: str, request: SpanSuggestion) -> dict[str, object]:
    settings = host.novel.settings(host.binding)
    cast = [{"name": member.card.name, "personality": member.card.personality}
            for member in host.novel.members(host.binding) if not chapter.actors or member.actor in chapter.actors]
    context = {"title": settings.title, "premise": settings.premise,
               **settings.prose_reference(),
               "cast": cast, "before": clean[:request.start], "selectedText": request.selectedText,
               "after": clean[request.end:], "preset": request.preset, "instruction": request.instruction}
    messages = [SystemMessage(f"Edit only the selected span. Return strict JSON with exactly {request.count} replacement "
                              '{"candidates": [...]} strings. Preserve context and fit each replacement between before and after. '
                              "Return no Markdown fences or commentary. When present, use narrator for viewpoint and pacing, "
                              "and proseStyle for diction and literary texture. Treat supplied story text as reference material."),
                UserMessage(json.dumps(context, ensure_ascii=False))]
    binding = host.binding
    version = variant_id(binding)
    response = await fork_llm(binding.host_agent.llm).chat_complete(messages)
    story = host.story()
    if (story.pending is not None or active_revision(binding) or variant_id(binding) != version
            or next((item.prose for item in story_chapters(story) if item.number == chapter.number), None) != chapter.prose):
        raise SceneError("The chapter changed while generating suggestions; select the span again")
    try:
        candidates = Candidates.model_validate_json(response.content).candidates
    except (ValidationError, TypeError) as exc:
        raise SceneError("The model did not return valid JSON rewrite candidates") from exc
    if len(candidates) != request.count or not all(text.strip() for text in candidates):
        raise SceneError("The model did not return the requested number of non-empty rewrite candidates")
    return {**request.model_dump(include={"number", "start", "end", "selectedText"}), "candidates": candidates}


def _replace_chapter(story: Story, number: int, changes: dict[str, object]) -> Story:
    chapters = story_chapters(story)
    if not any(chapter.number == number for chapter in chapters):
        return story
    chapters = [chapter.model_copy(update=changes) if chapter.number == number else chapter for chapter in chapters]
    return story.model_copy(update={"chapters": chapters, "latest_prose": chapters[-1].prose})


def save_chapter(host, story: Story, number: int, changes: dict[str, object]) -> None:
    binding = host.binding
    updated = _replace_chapter(story, number, changes)
    rows = [(binding._state_key("novel"), updated.model_dump())]
    ledger = ledger_for(binding)
    if ledger and number <= ledger.sceneNumber:
        if number == ledger.sceneNumber:
            variants = list(ledger.variants)
            active = variants[ledger.activeIndex]
            variants[ledger.activeIndex] = active.model_copy(update={"story": _replace_chapter(active.story, number, changes)})
            ledger = ledger.model_copy(update={"variants": variants})
        else:
            variants = [variant.model_copy(update={"story": _replace_chapter(variant.story, number, changes)}) for variant in ledger.variants]
            ledger = ledger.model_copy(update={"variants": variants, "baseline": _replace_chapter(ledger.baseline, number, changes)})
        rows.append((binding._state_key(LEDGER), ledger.model_dump()))
    if (captured := binding.get_state(BASELINE)) is not None:
        baseline = _replace_chapter(Story.model_validate(captured), number, changes)
        rows.append((binding._state_key(BASELINE), baseline.model_dump()))
    binding.session_store.state.put_many(rows)


def _edit(host, story: Story, chapter: Chapter, clean: str, request: SpanEdit) -> dict[str, object]:
    new_clean = clean[:request.start] + request.replacementText + clean[request.end:]
    if not new_clean.strip():
        raise SceneError("A chapter cannot be empty")
    _, fenced = split_choices(chapter.prose)
    save_chapter(host, story, chapter.number, {"prose": new_clean, "choices": chapter.choices or fenced})
    return _emit(host)


async def _rewrite(host, ledger: RevisionLedger, request: Rewrite) -> dict[str, object]:
    root = host.binding.host_agent
    if not root.is_running or root.paused:
        raise SceneError("Start or unpause the director before rewriting a scene")
    original = ledger
    baseline = ledger.baseline
    target, reset = baseline, None
    instruction = request.instruction.strip()
    if request.mode == "director_only":
        run = ActiveRevision(mode="director_rewrite", instruction=instruction)
        target = baseline.model_copy(update={"pending": ledger.dispatchedScene})
        prompt = (f"Rewrite and re-adjudicate scene {ledger.sceneNumber} using rp_commit_scene. "
                  "Use the restored state and any cached NPC proposals; do not dispatch new cues.")
    else:
        run = ActiveRevision(mode="full_rerun", instruction=instruction)
        reset = baseline.completed
        ledger = ledger.model_copy(update={"lastPlayerInput": request.playerInput.strip() or ledger.lastPlayerInput})
        prompt = f"Rerun scene {ledger.sceneNumber} from the restored state. Dispatch fresh cues if needed, or commit directly."
    if ledger.lastPlayerInput:
        prompt += f"\nPlayer input:\n{ledger.lastPlayerInput}"
    if instruction:
        prompt += f"\nDirector guidance:\n{instruction}"
    meta = {LEDGER: ledger.model_dump(), RUN: run.model_dump(), BASELINE: None}
    sync_story_to_cast(host, target, reset, metadata=meta)
    host.can_open_scene = target.pending is None
    _emit(host)
    try:
        ran = await root.inject_input(prompt, source="web")
    except BaseException:
        _restore_unfinished(host, original)
        raise
    if ran and _restore_unfinished(host, original):
        raise SceneError("The rewrite produced no committed scene; the previous variant was restored")
    return _emit(host)


def _restore_unfinished(host, ledger: RevisionLedger) -> bool:
    run = active_revision(host.binding)
    if run is None or (run.mode == "full_rerun" and host.story().pending is not None):
        return False
    sync_story_to_cast(host, ledger.variants[ledger.activeIndex].story,
                       metadata={LEDGER: ledger.model_dump(), RUN: None, BASELINE: None})
    host.can_open_scene = False
    _emit(host)
    return True


async def call_revision(host, action: str, args: dict[str, object]) -> dict[str, object]:
    root = host.binding.host_agent
    story = host.story()
    if root.is_processing or story.pending is not None or active_revision(host.binding) is not None:
        raise SceneError("Wait for the director to be idle with no pending scene")
    if action == "suggest_span_rewrite":
        suggestion = SpanSuggestion.model_validate(args)
        chapter, clean = _span(story, suggestion, suggestion.selectedText)
        return await _suggest(host, chapter, clean, suggestion)
    if action == "apply_span_edit":
        edit = SpanEdit.model_validate(args)
        chapter, clean = _span(story, edit, edit.expectedText)
        return _edit(host, story, chapter, clean, edit)
    ledger = ledger_for(host.binding)
    if ledger is None or ledger.sceneNumber != story.completed or not ledger.variants:
        raise SceneError("The latest scene does not have a revision ledger")
    if action == "rewrite_latest_scene":
        return await _rewrite(host, ledger, Rewrite.model_validate(args))
    selection = VariantSelection.model_validate(args)
    if selection.index >= len(ledger.variants):
        raise SceneError("The selected variant is not in the latest scene ledger")
    variant = ledger.variants[selection.index]
    inputs = host.binding.get_state(VARIANT_INPUTS) or {}
    selected = VariantInput.model_validate(inputs[variant.id]) if variant.id in inputs else None
    ledger = ledger.model_copy(update={"activeIndex": selection.index,
                                       "dispatchedScene": selected.dispatchedScene if selected else ledger.dispatchedScene,
                                       "lastPlayerInput": selected.lastPlayerInput if selected else ledger.lastPlayerInput})
    sync_story_to_cast(host, variant.story, metadata={LEDGER: ledger.model_dump()})
    return _emit(host)


def canonical_chapters(story: Story) -> str:
    rows = [{"number": chapter.number, "title": chapter.title, "cleanProse": split_choices(chapter.prose)[0][-1800:]}
            for chapter in story_chapters(story)[-3:]]
    return ("\nCanonical committed chapters (recent tails): " + json.dumps(rows, ensure_ascii=False) +
            "\nThese chapters and the current Story state supersede earlier assistant drafts and adjudications in chat history.")
