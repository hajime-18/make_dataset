#!/usr/bin/env python3
"""
表構造アノテーションツール（文字を含まない表構造のHTML正解データを作る）

起動:
    python app.py --images ./table_images --out ./dataset
    → ブラウザで http://127.0.0.1:8000 を開く

保存先（--out）:
    dataset/
      images/<元のファイル名>         … 作成済みの表の画像（元画像をそのままコピー）
      annotations/<ID>.json           … 編集状態（再編集用。行数・列数・結合・見出し行数・状態・メモ）
      table_structure.jsonl           … LLaMA-Factory（ShareGPT形式）の学習データ
      dataset_info.json               … LLaMA-Factory用のデータセット定義

学習データを書き出し直すだけ:
    python app.py --images ./table_images --out ./dataset --export-only
"""
import argparse
import json
import os
import shutil
import sys
import tempfile
from datetime import datetime
from pathlib import Path

from flask import Flask, abort, jsonify, request, send_file, send_from_directory

IMAGE_EXTS = {".png", ".jpg", ".jpeg", ".bmp", ".tif", ".tiff", ".webp", ".gif"}
DEFAULT_PROMPT = "この表の構造を、文字を含まないHTMLで出力してください。"
DATASET_NAME = "table_structure"
JSONL_NAME = "table_structure.jsonl"
STATUSES = {"todo", "done", "skipped"}


# ---------------------------------------------------------------- 構造 → HTML / 検査

def validate(struct):
    """表構造を検査する。(errors, warnings) を返す。errors があると保存しない。"""
    errors, warnings = [], []
    try:
        R, C, H = int(struct["rows"]), int(struct["cols"]), int(struct["header_rows"])
        merges = [tuple(int(v) for v in m) for m in struct.get("merges", [])]
    except (KeyError, TypeError, ValueError):
        return ["構造データの形式が不正です"], []
    if R < 1 or C < 1:
        errors.append("行数・列数は1以上にしてください")
        return errors, warnings
    if not 0 <= H <= R:
        errors.append(f"見出し行数 {H} が範囲外です（0〜{R}）")
    owner = {}
    for i, (r, c, rs, cs) in enumerate(merges):
        name = f"結合{i + 1}（{r + 1}行{c + 1}列から{rs}×{cs}）"
        if rs < 1 or cs < 1 or (rs == 1 and cs == 1):
            errors.append(f"{name}: 大きさが不正です")
            continue
        if r < 0 or c < 0 or r + rs > R or c + cs > C:
            errors.append(f"{name}: 表の範囲をはみ出しています")
            continue
        if r < H < r + rs:
            errors.append(f"{name}: 見出しと本文の境界をまたいでいます")
        for rr in range(r, r + rs):
            for cc in range(c, c + cs):
                if (rr, cc) in owner:
                    errors.append(f"{name}: 結合{owner[(rr, cc)] + 1}と重なっています")
                    break
                owner[(rr, cc)] = i
            else:
                continue
            break
    if not errors:
        # 行全体・列全体が1つの結合でしか構成されない行/列（=実質不要な行/列）を警告
        for r in range(R):
            if all((r, c) in owner and merges[owner[(r, c)]][0] < r for c in range(C)):
                warnings.append(f"{r + 1}行目はすべて上の行からの縦結合です（行が余分かもしれません）")
        for c in range(C):
            if all((r, c) in owner and merges[owner[(r, c)]][1] < c for r in range(R)):
                warnings.append(f"{_col_name(c)}列はすべて左の列からの横結合です（列が余分かもしれません）")
        if H == 0:
            warnings.append("見出し行が0行です（theadなしで保存されます）")
    return errors, warnings


def _col_name(c):
    s = ""
    c += 1
    while c:
        c, rem = divmod(c - 1, 26)
        s = chr(65 + rem) + s
    return s


def to_html(struct):
    """文字を含まない正規化HTML（1行）を作る。"""
    R, C, H = int(struct["rows"]), int(struct["cols"]), int(struct["header_rows"])
    anchor, covered = {}, set()
    for r, c, rs, cs in (tuple(int(v) for v in m) for m in struct.get("merges", [])):
        anchor[(r, c)] = (rs, cs)
        for rr in range(r, r + rs):
            for cc in range(c, c + cs):
                if (rr, cc) != (r, c):
                    covered.add((rr, cc))

    def row(r):
        out = []
        for c in range(C):
            if (r, c) in covered:
                continue
            attrs = ""
            if (r, c) in anchor:
                rs, cs = anchor[(r, c)]
                if rs > 1:
                    attrs += f' rowspan="{rs}"'
                if cs > 1:
                    attrs += f' colspan="{cs}"'
            out.append(f"<td{attrs}></td>")
        return "<tr>" + "".join(out) + "</tr>"

    html = "<table>"
    if H > 0:
        html += "<thead>" + "".join(row(r) for r in range(H)) + "</thead>"
    if H < R:
        html += "<tbody>" + "".join(row(r) for r in range(H, R)) + "</tbody>"
    return html + "</table>"


# ---------------------------------------------------------------- 保存まわり

def atomic_write(path: Path, text: str):
    path.parent.mkdir(parents=True, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=".tmp_", suffix=path.suffix)
    with os.fdopen(fd, "w", encoding="utf-8") as f:
        f.write(text)
    os.replace(tmp, path)


class Store:
    def __init__(self, image_dir: Path, out_dir: Path, prompt: str):
        self.image_dir = image_dir.resolve()
        self.out = out_dir.resolve()
        self.prompt = prompt
        self.ann_dir = self.out / "annotations"
        self.img_out = self.out / "images"
        self.ann_dir.mkdir(parents=True, exist_ok=True)
        self.img_out.mkdir(parents=True, exist_ok=True)

    def images(self):
        """{id: ファイル名} 。IDは拡張子を除いたファイル名。"""
        files = sorted(p for p in self.image_dir.iterdir()
                       if p.is_file() and p.suffix.lower() in IMAGE_EXTS and not p.name.startswith("."))
        result, dup = {}, []
        for p in files:
            if p.stem in result:
                dup.append(p.name)
                continue
            result[p.stem] = p.name
        return result, dup

    def ann_path(self, iid):
        return self.ann_dir / f"{iid}.json"

    def load(self, iid):
        p = self.ann_path(iid)
        if p.exists():
            return json.loads(p.read_text(encoding="utf-8"))
        return None

    def save(self, iid, filename, data):
        struct = data["structure"]
        status = data.get("status", "done")
        if status not in STATUSES:
            raise ValueError("状態が不正です")
        rec = {
            "id": iid,
            "image": filename,
            "status": status,
            "note": data.get("note", ""),
            "structure": {
                "rows": int(struct["rows"]),
                "cols": int(struct["cols"]),
                "header_rows": int(struct["header_rows"]),
                "merges": sorted([int(v) for v in m] for m in struct.get("merges", [])),
            },
            "html": to_html(struct) if status == "done" else None,
            "updated_at": datetime.now().isoformat(timespec="seconds"),
        }
        atomic_write(self.ann_path(iid), json.dumps(rec, ensure_ascii=False, indent=1))
        if status == "done":
            src, dst = self.image_dir / filename, self.img_out / filename
            if not dst.exists() or src.stat().st_mtime > dst.stat().st_mtime or src.stat().st_size != dst.stat().st_size:
                shutil.copy2(src, dst)
        return rec

    def export(self):
        """作成済み（done）の表から学習データを書き出し直す。"""
        lines, n_skip, missing = [], 0, []
        for p in sorted(self.ann_dir.glob("*.json")):
            rec = json.loads(p.read_text(encoding="utf-8"))
            if rec.get("status") != "done":
                n_skip += rec.get("status") == "skipped"
                continue
            if not (self.img_out / rec["image"]).exists():
                missing.append(rec["image"])
                continue
            errors, _ = validate(rec["structure"])
            if errors:
                missing.append(f'{rec["id"]}（構造エラー）')
                continue
            html = to_html(rec["structure"])
            lines.append(json.dumps({
                "messages": [
                    {"role": "user", "content": "<image>" + self.prompt},
                    {"role": "assistant", "content": html},
                ],
                "images": [f'images/{rec["image"]}'],
                "id": rec["id"],
            }, ensure_ascii=False))
        atomic_write(self.out / JSONL_NAME, "\n".join(lines) + ("\n" if lines else ""))
        info = {
            DATASET_NAME: {
                "file_name": JSONL_NAME,
                "formatting": "sharegpt",
                "columns": {"messages": "messages", "images": "images"},
                "tags": {"role_tag": "role", "content_tag": "content",
                         "user_tag": "user", "assistant_tag": "assistant"},
            }
        }
        atomic_write(self.out / "dataset_info.json", json.dumps(info, ensure_ascii=False, indent=2))
        return {"exported": len(lines), "skipped": n_skip, "problems": missing}


# ---------------------------------------------------------------- Web

def create_app(store: Store):
    app = Flask(__name__, static_folder=None)
    static_dir = Path(__file__).parent / "static"

    @app.get("/")
    def index():
        return send_from_directory(static_dir, "index.html")

    @app.get("/static/<path:name>")
    def static_files(name):
        return send_from_directory(static_dir, name)

    @app.get("/api/config")
    def config():
        return jsonify({"prompt": store.prompt, "image_dir": str(store.image_dir), "out_dir": str(store.out)})

    @app.get("/api/images")
    def list_images():
        imgs, dup = store.images()
        items = []
        for iid, fn in imgs.items():
            rec = store.load(iid)
            items.append({
                "id": iid, "file": fn,
                "status": rec["status"] if rec else "todo",
                "note": rec.get("note", "") if rec else "",
            })
        return jsonify({"items": items, "duplicates": dup})

    @app.get("/image/<iid>")
    def image(iid):
        imgs, _ = store.images()
        if iid not in imgs:
            abort(404)
        resp = send_file(store.image_dir / imgs[iid])
        resp.headers["Cache-Control"] = "no-store"
        return resp

    @app.get("/api/annotation/<iid>")
    def get_ann(iid):
        imgs, _ = store.images()
        if iid not in imgs:
            abort(404)
        return jsonify(store.load(iid))

    @app.post("/api/check")
    def check():
        struct = request.get_json(force=True)
        errors, warnings = validate(struct)
        return jsonify({"errors": errors, "warnings": warnings,
                        "html": None if errors else to_html(struct)})

    @app.post("/api/annotation/<iid>")
    def put_ann(iid):
        imgs, _ = store.images()
        if iid not in imgs:
            abort(404)
        data = request.get_json(force=True)
        status = data.get("status", "done")
        errors, warnings = validate(data.get("structure", {}))
        if status == "done" and errors:
            return jsonify({"ok": False, "errors": errors, "warnings": warnings}), 400
        if status == "skipped" and not data.get("structure"):
            data["structure"] = {"rows": 1, "cols": 1, "header_rows": 0, "merges": []}
        rec = store.save(iid, imgs[iid], data)
        exp = store.export()
        return jsonify({"ok": True, "record": rec, "warnings": warnings, "export": exp})

    @app.post("/api/export")
    def export():
        return jsonify(store.export())

    return app


def main():
    ap = argparse.ArgumentParser(description="表構造アノテーションツール")
    ap.add_argument("--images", required=True, help="表画像のフォルダ")
    ap.add_argument("--out", required=True, help="データセットの出力フォルダ")
    ap.add_argument("--prompt", default=DEFAULT_PROMPT, help="学習データの指示文")
    ap.add_argument("--host", default="127.0.0.1", help="待ち受けアドレス（既定: 127.0.0.1）")
    ap.add_argument("--port", type=int, default=8000)
    ap.add_argument("--export-only", action="store_true", help="学習データを書き出して終了")
    args = ap.parse_args()

    image_dir = Path(args.images)
    if not image_dir.is_dir():
        sys.exit(f"画像フォルダが見つかりません: {image_dir}")
    store = Store(image_dir, Path(args.out), args.prompt)
    _, dup = store.images()
    if dup:
        print(f"警告: 拡張子だけが異なる同名ファイルは無視します: {', '.join(dup)}", file=sys.stderr)

    if args.export_only:
        r = store.export()
        print(f"書き出し: {r['exported']} 件（スキップ {r['skipped']} 件） -> {store.out / JSONL_NAME}")
        for p in r["problems"]:
            print(f"  問題あり: {p}", file=sys.stderr)
        return

    store.export()
    print(f"画像: {store.image_dir}\n保存先: {store.out}\nhttp://{args.host}:{args.port} を開いてください")
    create_app(store).run(host=args.host, port=args.port, debug=False, threaded=True)


if __name__ == "__main__":
    main()
