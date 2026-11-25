"""Built-in narrator snapshot and editable Tavern PNG template."""

import base64
import json
import struct
import zlib
from pathlib import Path

from pydantic import BaseModel

from .cards import CardFields

DEFAULT_NARRATOR_ID = "__default__"
DEFAULT_NARRATOR_ASSET = Path(__file__).parent / "assets" / "default_narrator.png"
DEFAULT_NARRATOR_PORTRAIT_URL = "/api/ext/kohaku-roleplay/default-narrator.png"
DEFAULT_NARRATOR_FIELDS = CardFields(
    name="沉浸小说旁白",
    description=(
        "自动匹配读者输入、开局背景与当前登场角色卡所使用的语言直接展开场景叙事：绝不以说书人、评论者、主持人或系统身份自称，绝不打破第四面墙向读者搭话。\n"
        "用具体的感官锚点承载情绪与氛围——光线冷暖、环境细响、身体姿态、器物触感与人物间的空间距离，避免空洞的心理概括与形容词堆砌。\n"
        "在「扮演主角模式」下，镜头感知紧贴主角当下的视线与行动意图展开细节，绝不替主角擅自编造未授权的长篇台词、重大立场表态或违背玩家意图的心理决定；在「上帝导演模式」下，依戏剧重心在在场角色间自然调度镜头。\n"
        "将各在场 NPC 回报的台词（speech）与拟做动作（attempted_action）无缝编织进连贯场面；对于角色的私有反应（private_reaction），仅将其外化为可被观察到的微动作与潜台词（如话音顿住、错开视线、呼吸轻重、指节收紧），绝不用全知旁白大白话直接剧透角色底牌。"
    ),
    personality=(
        "行文克制、具象、讲求呼吸节奏：日常交谈轻快留白，冲突与转折处放慢镜头聚焦五感细节；对话与细微动作穿插推进，避免整段干瘪说明文或纯台词罗列。\n"
        "每一幕必须在具体的动作、未完成的半个手势、一句余音未落的对白或安静的器物细节处利落收尾。\n"
        "严禁在章末做总结陈词、主旨升华、宿命感预告或悬念套话（禁止“空气仿佛凝固了”“命运的齿轮开始转动”“一场风暴正在酝酿”“没人知道接下来会发生什么”等句式）；禁用浮夸网文套话（如“瞳孔地震”“生理性厌恶”“嘴角勾起三分凉薄”）。\n"
        "用词尺度与时代质感严格贴合当前挂载的世界书与角色卡设定，不混入无关题材的网络流行语或违和词汇。"
    ),
    scenario="",
    first_mes="",
    mes_example=(
        "「就放在这儿？」她捏着纸页一角，没有立刻松手。\n"
        "「再往灯下移一点。」他的目光停在她手背上，没有去接。\n\n"
        "茶盏落回桌面，瓷底轻叩木纹，杯柄擦过他的指节。"
    ),
    tags=["narrator"],
    creator_notes="Kohaku Roleplay 内置默认旁白模板。可复制到角色卡库自由修改为专属旁白卡或文风卡。",
)


class Narrator(BaseModel):
    cardId: str
    name: str
    description: str
    personality: str
    voice_examples: str
    isDefault: bool = False


def card_voice(card_id: str, fields: CardFields) -> Narrator:
    return Narrator(cardId=card_id, name=fields.name, description=fields.description, personality=fields.personality,
                    voice_examples=fields.mes_example, isDefault=card_id == DEFAULT_NARRATOR_ID)


def default_narrator_narrator() -> Narrator:
    return card_voice(DEFAULT_NARRATOR_ID, DEFAULT_NARRATOR_FIELDS)


def default_narrator_png_card() -> bytes:
    raw = DEFAULT_NARRATOR_ASSET.read_bytes()
    data = {**DEFAULT_NARRATOR_FIELDS.model_dump(), "character_version": "1.0", "extensions": {}}
    chunks = []
    for key, spec, spec_version, fields in (
        (b"chara", "chara_card_v2", "2.0", data),
        (b"ccv3", "chara_card_v3", "3.0", {**data, "group_only_greetings": []}),
    ):
        document = json.dumps({"spec": spec, "spec_version": spec_version, "data": fields},
                              ensure_ascii=False, separators=(",", ":")).encode("utf-8")
        content = key + b"\0" + base64.b64encode(document)
        chunk = b"tEXt" + content
        chunks.append(struct.pack(">I", len(content)) + chunk + struct.pack(">I", zlib.crc32(chunk)))
    # Insert before IEND so the original image data and all existing chunks remain intact.
    return raw[:-12] + b"".join(chunks) + raw[-12:]


def default_narrator_view() -> dict[str, object]:
    fields = DEFAULT_NARRATOR_FIELDS
    return {"id": DEFAULT_NARRATOR_ID, "name": fields.name, "portraitUrl": DEFAULT_NARRATOR_PORTRAIT_URL,
            "description": fields.description, "personality": fields.personality, "examples": fields.mes_example}
