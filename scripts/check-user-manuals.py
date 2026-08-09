#!/usr/bin/env python3
"""检查四份用户手册的任务结构、截图和角色边界。"""

from __future__ import annotations

import json
import re
import zipfile
from pathlib import Path
from xml.etree import ElementTree as ET


REPO_ROOT = Path(__file__).resolve().parents[1]
MANUAL_DIR = REPO_ROOT / "docs" / "用户手册"
MANUALS = [
    ("实例管理员", "实例管理员使用手册.md", "公益智助柜实例管理员使用手册.docx", 11),
    ("商户", "商户使用手册.md", "公益智助柜商户使用手册.docx", 9),
    ("补货员", "补货员使用手册.md", "公益智助柜补货员使用手册.docx", 8),
    ("App 用户", "App用户使用手册.md", "公益智助柜App用户使用手册.docx", 10),
]
FORBIDDEN_TEXT = (
    "服务商",
    "服务管理员",
    "VNC",
    "sudo",
    "部署过程",
    "验收",
    "设计自述",
    "local-isolated",
    "模拟服务",
    "全真模拟",
)
REQUIRED_TASKS = {
    "实例管理员": ("审核注册申请", "Excel", "后台账号", "分配可管理柜机", "一次性人工验证码", "柜机状态", "处理密码"),
    "商户": ("维护常用商品", "登录移动端", "登记入柜数量", "历史记录"),
    "补货员": ("登录移动端", "进入移动补货页", "填写入柜记录", "反馈异常"),
    "App 用户": ("首次登记资料", "短信验证码登录", "一次性人工码备用登录", "提交预约", "打开当前预约", "领取结果"),
}
NS = {
    "w": "http://schemas.openxmlformats.org/wordprocessingml/2006/main",
    "a": "http://schemas.openxmlformats.org/drawingml/2006/main",
    "r": "http://schemas.openxmlformats.org/officeDocument/2006/relationships",
    "pr": "http://schemas.openxmlformats.org/package/2006/relationships",
    "cp": "http://schemas.openxmlformats.org/package/2006/metadata/core-properties",
    "dc": "http://purl.org/dc/elements/1.1/",
}


def fail(message: str) -> None:
    raise AssertionError(message)


def section_blocks(text: str) -> list[tuple[str, str]]:
    matches = list(re.finditer(r"^##\s+(.+)$", text, flags=re.MULTILINE))
    blocks = []
    for index, match in enumerate(matches):
        start = match.end()
        end = matches[index + 1].start() if index + 1 < len(matches) else len(text)
        blocks.append((match.group(1).strip(), text[start:end]))
    return blocks


def check_markdown(role: str, path: Path, minimum_tasks: int) -> None:
    text = path.read_text(encoding="utf-8")
    for forbidden in FORBIDDEN_TEXT:
        if forbidden in text:
            fail(f"{path.name} 含禁止文字：{forbidden}")

    blocks = section_blocks(text)
    tasks = [(title, block) for title, block in blocks if title != "遇到问题"]
    if len(tasks) < minimum_tasks:
        fail(f"{path.name} 任务数量不足：{len(tasks)} < {minimum_tasks}")
    if not blocks or blocks[-1][0] != "遇到问题":
        fail(f"{path.name} 末尾缺少“遇到问题”")

    for title, block in tasks:
        if "**用途：**" not in block:
            fail(f"{path.name} / {title} 缺用途")
        if "**完成标志：**" not in block:
            fail(f"{path.name} / {title} 缺完成标志")
        steps = re.findall(r"^\d+\.\s+", block, flags=re.MULTILINE)
        if not 3 <= len(steps) <= 6:
            fail(f"{path.name} / {title} 步骤数应为 3–6，实际 {len(steps)}")
        images = re.findall(r"^!\[(.+?)\]\((.+?)\)$", block, flags=re.MULTILINE)
        if not images:
            fail(f"{path.name} / {title} 没有关联截图")
        for _, relative in images:
            if "local-isolated" in relative:
                fail(f"{path.name} 引用了旧隔离截图：{relative}")
            image_path = (path.parent / relative).resolve()
            if not image_path.exists() or image_path.stat().st_size < 10_000:
                fail(f"{path.name} 截图无效：{image_path}")

    issues = re.findall(r"^-\s+\*\*(.+?)：\*\*\s+(.+)$", blocks[-1][1], flags=re.MULTILINE)
    if not 3 <= len(issues) <= 6:
        fail(f"{path.name} 故障项应为 3–6，实际 {len(issues)}")

    if role == "App 用户":
        if "短信验证码" not in text or "一次性人工码备用登录" not in text:
            fail("App 手册必须同时说明短信正常登录和人工码备用登录")

    headings = "\n".join(title for title, _ in tasks)
    for required in REQUIRED_TASKS[role]:
        if required not in headings:
            fail(f"{path.name} 缺少关键任务：{required}")


def attribute(element: ET.Element, namespace: str, name: str) -> str | None:
    return element.get(f"{{{NS[namespace]}}}{name}")


def check_docx(path: Path, markdown_path: Path, minimum_tasks: int) -> None:
    if not path.exists() or path.stat().st_size < 80_000:
        fail(f"Word 文件不存在或过小：{path}")
    with zipfile.ZipFile(path) as archive:
        names = archive.namelist()
        media = [name for name in names if name.startswith("word/media/")]
        if not media:
            fail(f"Word 文件没有截图：{path}")
        document_root = ET.fromstring(archive.read("word/document.xml"))
        styles_root = ET.fromstring(archive.read("word/styles.xml"))
        numbering_root = ET.fromstring(archive.read("word/numbering.xml"))
        relationships_root = ET.fromstring(archive.read("word/_rels/document.xml.rels"))
        core_root = ET.fromstring(archive.read("docProps/core.xml"))

        visible_text = "".join(item.text or "" for item in document_root.findall(".//w:t", NS))
        if "目录" not in visible_text:
            fail(f"Word 文件缺少目录：{path}")
        if "遇到问题" not in visible_text:
            fail(f"Word 文件缺少故障页：{path}")
        for forbidden in FORBIDDEN_TEXT:
            if forbidden in visible_text:
                fail(f"Word 文件含禁止文字：{path.name} / {forbidden}")

        if document_root.findall(".//w:ins", NS) or document_root.findall(".//w:del", NS):
            fail(f"Word 文件仍含修订标记：{path}")
        if any("comments" in name.lower() for name in names):
            fail(f"Word 文件仍含批注：{path}")
        if document_root.findall('.//w:trHeight[@w:hRule="exact"]', NS):
            fail(f"Word 表格含可能截断文字的固定行高：{path}")

        section = document_root.find(".//w:sectPr", NS)
        if section is None:
            fail(f"Word 文件缺少页面设置：{path}")
        page_size = section.find("w:pgSz", NS)
        page_margins = section.find("w:pgMar", NS)
        if page_size is None or page_margins is None:
            fail(f"Word 文件页面设置不完整：{path}")
        if (int(attribute(page_size, "w", "w") or 0), int(attribute(page_size, "w", "h") or 0)) != (11906, 16838):
            fail(f"Word 文件不是 A4 纵向：{path}")
        expected_margins = {"top": 822, "bottom": 822, "left": 879, "right": 879, "header": 369, "footer": 369}
        for key, expected in expected_margins.items():
            actual = int(attribute(page_margins, "w", key) or 0)
            if abs(actual - expected) > 2:
                fail(f"Word 文件页边距不符合紧凑版式：{path.name} / {key}={actual}")

        normal_style = styles_root.find('.//w:style[@w:styleId="Normal"]', NS)
        if normal_style is None:
            fail(f"Word 文件缺少 Normal 样式：{path}")
        normal_size = normal_style.find("w:rPr/w:sz", NS)
        normal_spacing = normal_style.find("w:pPr/w:spacing", NS)
        if normal_size is None or attribute(normal_size, "w", "val") != "21":
            fail(f"Word 正文不是 10.5 磅：{path}")
        if normal_spacing is None or attribute(normal_spacing, "w", "line") != "300":
            fail(f"Word 正文行距不是 1.25 倍：{path}")

        table_nodes = document_root.findall(".//w:tbl", NS)
        if not table_nodes:
            fail(f"Word 文件缺少任务提示框：{path}")
        for table in table_nodes:
            width = table.find("w:tblPr/w:tblW", NS)
            indent = table.find("w:tblPr/w:tblInd", NS)
            layout = table.find("w:tblPr/w:tblLayout", NS)
            grid = table.findall("w:tblGrid/w:gridCol", NS)
            if width is None or attribute(width, "w", "type") != "dxa":
                fail(f"Word 表格缺少固定 DXA 宽度：{path}")
            if indent is None or attribute(indent, "w", "w") != "120":
                fail(f"Word 表格缩进不符合版式：{path}")
            if layout is None or attribute(layout, "w", "type") != "fixed":
                fail(f"Word 表格未使用固定布局：{path}")
            grid_widths = [int(attribute(column, "w", "w") or 0) for column in grid]
            if not grid_widths or sum(grid_widths) != int(attribute(width, "w", "w") or 0):
                fail(f"Word 表格网格与总宽度不一致：{path}")
            for row in table.findall("w:tr", NS):
                cells = row.findall("w:tc", NS)
                if len(cells) != len(grid_widths):
                    fail(f"Word 表格列数与网格不一致：{path}")
                for cell, expected_width in zip(cells, grid_widths):
                    cell_width = cell.find("w:tcPr/w:tcW", NS)
                    if cell_width is None or int(attribute(cell_width, "w", "w") or 0) != expected_width:
                        fail(f"Word 表格单元格宽度与网格不一致：{path}")

        markdown = markdown_path.read_text(encoding="utf-8")
        expected_sections = [title for title, _ in section_blocks(markdown)]
        expected_steps = len(re.findall(r"^\d+\.\s+", markdown, flags=re.MULTILINE))
        expected_images = len(re.findall(r"^!\[", markdown, flags=re.MULTILINE))
        numbered_paragraphs = len(document_root.findall(".//w:pPr/w:numPr", NS))
        drawings = len(document_root.findall(".//a:blip", NS))
        page_breaks = len(document_root.findall('.//w:br[@w:type="page"]', NS)) + len(
            document_root.findall('.//w:pageBreakBefore', NS)
        )
        if numbered_paragraphs != expected_steps:
            fail(f"Word 真编号数量不符：{path.name} / {numbered_paragraphs} != {expected_steps}")
        if drawings != expected_images:
            fail(f"Word 截图数量不符：{path.name} / {drawings} != {expected_images}")
        if page_breaks < minimum_tasks:
            fail(f"Word 任务分页不足：{path.name} / {page_breaks} < {minimum_tasks}")

        internal_links = document_root.findall('.//w:hyperlink[@w:anchor]', NS)
        linked_titles = ["".join(item.text or "" for item in link.findall(".//w:t", NS)) for link in internal_links]
        linked_anchors = [attribute(link, "w", "anchor") for link in internal_links]
        expected_anchors = [f"manual_section_{index:02d}" for index in range(1, len(expected_sections) + 1)]
        if linked_titles != expected_sections:
            fail(f"Word 目录条目与正文标题不一致：{path.name}")
        if linked_anchors != expected_anchors:
            fail(f"Word 目录链接顺序不正确：{path.name}")
        bookmark_names = {attribute(item, "w", "name") for item in document_root.findall(".//w:bookmarkStart", NS)}
        if "manual_toc" not in bookmark_names or not set(expected_anchors).issubset(bookmark_names):
            fail(f"Word 目录书签不完整：{path.name}")

        level_texts = [attribute(item, "w", "val") for item in numbering_root.findall(".//w:lvlText", NS)]
        if "%1." not in level_texts:
            fail(f"Word 文件缺少十进制真编号定义：{path}")
        for relationship in relationships_root.findall("pr:Relationship", NS):
            if relationship.get("TargetMode") == "External":
                fail(f"Word 文件含外部关系：{path}")
        author = core_root.find("dc:creator", NS)
        if author is None or author.text != "公益智助柜":
            fail(f"Word 文件作者元数据未清理：{path}")


def check_manifest() -> None:
    manifest_path = MANUAL_DIR / "截图清单.json"
    manifest = json.loads(manifest_path.read_text(encoding="utf-8"))
    outputs = set()
    for item in manifest["images"]:
        source = item["source"]
        if any(fragment in source for fragment in manifest["forbiddenSourceFragments"]):
            fail(f"截图清单引用了禁止源图：{source}")
        output = REPO_ROOT / item["output"]
        if not output.exists() or output.stat().st_size < 10_000:
            fail(f"截图尚未生成或无效：{output}")
        if item["output"] in outputs:
            fail(f"截图输出路径重复：{item['output']}")
        outputs.add(item["output"])


def main() -> int:
    check_manifest()
    for role, markdown_name, docx_name, minimum_tasks in MANUALS:
        markdown_path = MANUAL_DIR / markdown_name
        check_markdown(role, markdown_path, minimum_tasks)
        check_docx(MANUAL_DIR / docx_name, markdown_path, minimum_tasks)
        print(f"通过：{role}")
    print("四份用户手册结构、截图和角色边界检查通过。")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
