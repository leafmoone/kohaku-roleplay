"""Package-owner RPC for the single-user, reusable character library."""

import asyncio
import base64
import binascii

from pydantic import ValidationError
from kohakuterrarium.api.ext import UICallContext
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError, UIOwnerMixin

from .card_editor import CopyRequest, edit_draft, save_copy
from .cards import MAX_CARD_BYTES, CardError, card_format, parse_card
from .charx import MAX_ARCHIVE_BYTES
from .library import (CardNotFound, card_scripts_default, import_card, list_cards,
                      original_card, remove_card, set_card_scripts_default)
from .library_view import card_detail, media_view, portrait_view
from .module_library import MAX_CARD_MODULES, snapshot_modules
from .opening_page_library import (opening_module_dependencies, opening_module_plan,
                                   opening_page_dependencies, snapshot_opening_module, snapshot_opening_page)
from .portrait_library import PortraitCopy, portrait_draft, save_portraits_copy
from .runtime import library_dir
from .script_dependencies import script_dependencies
from .worldbook_library import (MAX_WORLDBOOK_BYTES, WorldbookNotFound, embedded_worldbook, import_worldbook,
                                list_worldbooks, original_worldbook, preview_worldbook, remove_worldbook,
                                set_default_worldbook, worldbook_detail)


def single_user(context: UICallContext) -> None:
    if context.multi_user:
        raise OwnerForbiddenError("The roleplay library currently supports single-user KT hosts only")


def _id(args: dict[str, object]) -> str:
    key = args.get("id")
    if not isinstance(key, str) or not key:
        raise OwnerArgumentError("A card id is required")
    return key


def _worldbook_upload(args: dict[str, object]) -> tuple[bytes, str]:
    source, name = args.get("data"), args.get("name")
    if (not isinstance(source, str) or not source.isascii() or len(source) > 4 * ((MAX_WORLDBOOK_BYTES + 2) // 3)
            or not isinstance(name, str)):
        raise OwnerArgumentError("Expected a named Base64-encoded JSON worldbook (2 MiB maximum)")
    return base64.b64decode(source, validate=True), name


def _card_upload(args: dict[str, object]) -> bytes:
    source = args.get("data")
    if not isinstance(source, str) or not source.isascii() or len(source) > 4 * ((MAX_ARCHIVE_BYTES + 2) // 3):
        raise OwnerArgumentError("Expected a Base64-encoded JSON/PNG (12 MiB) or CHARX (32 MiB) card")
    return base64.b64decode(source, validate=True)


def _preview_card_dependencies(args: dict[str, object]) -> dict:
    card = parse_card(_card_upload(args))
    return {"name": card.fields.name, "scripts": script_dependencies(card.scripts),
            **({"remoteOpeningPage": page.model_dump()} if (page := card.legacy_remote_opening) else {})}


class CardCatalog(UIOwnerMixin):
    """Serve card metadata and media without sharing any session's experiences."""

    async def ui_state(self, context: UICallContext) -> dict[str, object]:
        single_user(context)
        directory = library_dir()
        books, defaults = await asyncio.to_thread(list_worldbooks, directory)
        return {"cards": await asyncio.to_thread(list_cards, directory), "maxCardBytes": MAX_CARD_BYTES,
                "maxArchiveBytes": MAX_ARCHIVE_BYTES, "worldbooks": books, "cardWorldbookDefaults": defaults,
                "maxWorldbookBytes": MAX_WORLDBOOK_BYTES,
                "cardScriptsDefault": await asyncio.to_thread(card_scripts_default, directory)}

    async def ui_call(self, action: str, args: dict[str, object], context: UICallContext) -> object:
        single_user(context)
        directory = library_dir()
        try:
            if action == "set_card_scripts_default":
                enabled = args.get("enabled")
                if set(args) != {"enabled"} or type(enabled) is not bool:
                    raise OwnerArgumentError("Expected a boolean default for new taverns")
                await asyncio.to_thread(set_card_scripts_default, directory, enabled)
                state = await self.ui_state(context)
                self.ui_emit("state", state)
                return state
            if action == "preview_worldbook":
                return await asyncio.to_thread(preview_worldbook, *_worldbook_upload(args))
            if action == "import_worldbook":
                book = await asyncio.to_thread(import_worldbook, directory, *_worldbook_upload(args))
                self.ui_emit("state", await self.ui_state(context))
                return book
            if action == "worldbook_detail":
                return await asyncio.to_thread(worldbook_detail, directory, _id(args))
            if action == "embedded_worldbook":
                return await asyncio.to_thread(embedded_worldbook, directory, _id(args))
            if action == "export_worldbook":
                ref, raw = await asyncio.to_thread(original_worldbook, directory, _id(args))
                return {"data": base64.b64encode(raw).decode("ascii"), "format": "json", "name": ref["name"]}
            if action == "remove_worldbook":
                await asyncio.to_thread(remove_worldbook, directory, _id(args))
                state = await self.ui_state(context)
                self.ui_emit("state", state)
                return state
            if action == "set_default_worldbook":
                card_id, book_id = args.get("cardId"), args.get("bookId")
                if (not isinstance(card_id, str) or not card_id or "bookId" not in args
                        or (book_id is not None and (not isinstance(book_id, str) or not book_id))):
                    raise OwnerArgumentError("Expected a card id and a book id or null")
                await asyncio.to_thread(set_default_worldbook, directory, card_id, book_id)
                state = await self.ui_state(context)
                self.ui_emit("state", state)
                return state
            if action == "preview_card_dependencies":
                if set(args) != {"data"}:
                    raise OwnerArgumentError("Expected only the card file for dependency preview")
                return await asyncio.to_thread(_preview_card_dependencies, args)
            if action == "confirm_card_modules":
                urls = args.get("urls")
                if (set(args) != {"id", "urls"} or not isinstance(urls, list) or len(urls) > MAX_CARD_MODULES
                        or not all(isinstance(url, str) and 0 < len(url) <= 2048 for url in urls)):
                    raise OwnerArgumentError("Confirm the card and up to six literal HTTPS module sources")
                modules = await asyncio.to_thread(snapshot_modules, directory, _id(args), urls)
                return {"modules": modules}
            if action == "confirm_card_opening_page":
                url = args.get("url")
                if set(args) != {"id", "url"} or not isinstance(url, str) or not 0 < len(url) <= 2048:
                    raise OwnerArgumentError("Confirm the card and its exact external opening page URL")
                page = await asyncio.to_thread(snapshot_opening_page, directory, _id(args), url)
                return {"openingPage": page}
            if action == "preview_card_opening_dependencies":
                if set(args) != {"id"}:
                    raise OwnerArgumentError("Choose the card with the saved opening page")
                return await asyncio.to_thread(opening_page_dependencies, directory, _id(args))
            if action == "preview_card_opening_module_plan":
                if set(args) != {"id"}:
                    raise OwnerArgumentError("Choose a card to inspect its saved opening-page modules")
                return await asyncio.to_thread(opening_module_plan, directory, _id(args))
            if action == "preview_card_opening_module_dependencies":
                url = args.get("url")
                if set(args) != {"id", "url"} or not isinstance(url, str) or not 0 < len(url) <= 2048:
                    raise OwnerArgumentError("Choose the card and its saved parent opening module")
                return await asyncio.to_thread(opening_module_dependencies, directory, _id(args), url)
            if action == "confirm_card_opening_module":
                url = args.get("url")
                parent = args.get("parentUrl")
                if (set(args) not in ({"id", "url"}, {"id", "url", "parentUrl"})
                        or not isinstance(url, str) or not 0 < len(url) <= 2048
                        or ("parentUrl" in args and (not isinstance(parent, str) or not 0 < len(parent) <= 2048))):
                    raise OwnerArgumentError("Confirm the card and one module URL from its saved opening page or parent module")
                module = await asyncio.to_thread(snapshot_opening_module, directory, _id(args), url, parent_url=parent)
                return {"openingModule": module}
            if action == "import":
                card = await asyncio.to_thread(import_card, directory, _card_upload(args))
                self.ui_emit("state", await self.ui_state(context))
                return card
            if action == "edit_draft":
                return await asyncio.to_thread(edit_draft, directory, _id(args))
            if action == "save_copy":
                card = await asyncio.to_thread(save_copy, directory, CopyRequest.model_validate(args))
                self.ui_emit("state", await self.ui_state(context))
                return card
            if action == "detail":
                return await asyncio.to_thread(card_detail, directory, _id(args))
            if action == "portrait_draft":
                return await asyncio.to_thread(portrait_draft, directory, _id(args))
            if action == "save_portraits_copy":
                card = await asyncio.to_thread(save_portraits_copy, directory, PortraitCopy.model_validate(args))
                self.ui_emit("state", await self.ui_state(context))
                return card
            if action == "media":
                media_key = args.get("key")
                if not isinstance(media_key, str) or not media_key:
                    raise OwnerArgumentError("A media key is required")
                return await asyncio.to_thread(media_view, directory, _id(args), media_key)
            if action == "portrait":
                variant = args.get("variant")
                if variant is not None and not isinstance(variant, str):
                    raise OwnerArgumentError("Expected a portrait key")
                return await asyncio.to_thread(portrait_view, directory, _id(args), variant)
            if action == "remove":
                await asyncio.to_thread(remove_card, directory, _id(args))
                state = await self.ui_state(context)
                self.ui_emit("state", state)
                return state
            if action == "export_original":
                data = await asyncio.to_thread(original_card, directory, _id(args))
                return {"data": base64.b64encode(data).decode("ascii"), "format": card_format(data)}
        except ValidationError as exc:
            issue = exc.errors(include_input=False)[0]
            raise OwnerArgumentError(f"Invalid card edit at {issue['loc']}: {issue['msg']}") from exc
        except (CardError, CardNotFound, WorldbookNotFound, binascii.Error) as exc:
            raise OwnerArgumentError(f"Card {action} failed: {exc}") from exc
        raise OwnerArgumentError(f"Unknown roleplay library action: {action!r}")
