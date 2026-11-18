"""Package-owner RPC for the single-user, reusable character library."""

import asyncio
import base64
import binascii

from pydantic import ValidationError
from kohakuterrarium.api.ext import UICallContext
from kohakuterrarium.modules.ui_owner import OwnerArgumentError, OwnerForbiddenError, UIOwnerMixin

from .card_editor import CopyRequest, edit_draft, save_copy
from .cards import MAX_CARD_BYTES, CardError, card_format
from .charx import MAX_ARCHIVE_BYTES
from .library import CardNotFound, import_card, list_cards, original_card, remove_card
from .library_view import card_detail, media_view, portrait_view
from .portrait_library import PortraitCopy, portrait_draft, save_portraits_copy
from .runtime import library_dir


def single_user(context: UICallContext) -> None:
    if context.multi_user:
        raise OwnerForbiddenError("The roleplay library currently supports single-user KT hosts only")


def _id(args: dict[str, object]) -> str:
    key = args.get("id")
    if not isinstance(key, str) or not key:
        raise OwnerArgumentError("A card id is required")
    return key


class CardCatalog(UIOwnerMixin):
    """Serve card metadata and media without sharing any session's experiences."""

    async def ui_state(self, context: UICallContext) -> dict[str, object]:
        single_user(context)
        return {"cards": await asyncio.to_thread(list_cards, library_dir()), "maxCardBytes": MAX_CARD_BYTES,
                "maxArchiveBytes": MAX_ARCHIVE_BYTES}

    async def ui_call(self, action: str, args: dict[str, object], context: UICallContext) -> object:
        single_user(context)
        directory = library_dir()
        try:
            if action == "import":
                source = args.get("data")
                if not isinstance(source, str) or not source.isascii() or len(source) > 4 * ((MAX_ARCHIVE_BYTES + 2) // 3):
                    raise OwnerArgumentError("Expected a Base64-encoded JSON/PNG (12 MiB) or CHARX (32 MiB) card")
                card = await asyncio.to_thread(import_card, directory, base64.b64decode(source, validate=True))
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
        except (CardError, CardNotFound, binascii.Error) as exc:
            raise OwnerArgumentError(f"Card {action} failed: {exc}") from exc
        raise OwnerArgumentError(f"Unknown roleplay library action: {action!r}")
