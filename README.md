# 表構造アノテーションツール

表画像を左に表示し、右のExcel風グリッドで **文字を含まない表構造（白紙の表）** を作るWebアプリです。
作成した構造は、元画像と一緒に LLaMA-Factory（ShareGPT形式）の学習データとして保存されます。

## 起動（Linux）

```bash
pip install -r requirements.txt
python app.py --images /path/to/table_images --out /path/to/dataset
```

ブラウザで http://127.0.0.1:8000 を開きます。

別のPCのブラウザから使う場合は、SSHのポート転送を使います（サーバ側は既定の 127.0.0.1 のままでよい）。

```bash
ssh -L 8000:127.0.0.1:8000 ユーザ名@研究室PC
```

| オプション | 説明 |
| --- | --- |
| `--images` | 表画像のフォルダ（png / jpg / bmp / tif / webp / gif） |
| `--out` | データセットの出力フォルダ |
| `--prompt` | 学習データの指示文（既定:「この表の構造を、文字を含まないHTMLで出力してください。」） |
| `--port` / `--host` | 待ち受けポート・アドレス（既定: 8000 / 127.0.0.1） |
| `--export-only` | 画面を開かずに学習データだけ書き出し直す |

## 出力

```
dataset/
  images/t001.png              元画像をそのままコピー（作成済みの表のみ）
  annotations/t001.json        編集状態（再編集用）
  table_structure.jsonl        学習データ（作成済みの表のみ。保存のたびに自動で更新）
  dataset_info.json            LLaMA-Factory用の定義（データセット名: table_structure）
```

学習データ1件の例:

```json
{"messages": [{"role": "user", "content": "<image>この表の構造を、文字を含まないHTMLで出力してください。"},
              {"role": "assistant", "content": "<table><thead><tr><td rowspan=\"2\"></td><td colspan=\"2\"></td></tr><tr><td></td><td></td></tr></thead><tbody><tr><td></td><td></td><td></td></tr></tbody></table>"}],
 "images": ["images/t001.png"], "id": "t001"}
```

LLaMA-Factoryでは、`dataset_dir` にこの出力フォルダを、`dataset` に `table_structure` を指定します。

## HTMLの決まり

- 使うタグは `table` `thead` `tbody` `tr` `td` だけで、属性は `rowspan` と `colspan` だけ。セルは常に空（`<td></td>`）。
- 見出し（thead）は、表の上から「見出し行数」の行。0行なら thead は出力しない。
- 見出しと本文の境界をまたぐ結合はできない。
- 改行や空白は入れず、1行で出力する。

## 画面の使い方

- 表の画像ID は、拡張子を除いたファイル名です。拡張子だけが違う同名ファイルは、後のほうが無視されます。
- 一覧の色: 灰色＝未着手、緑＝作成済み、橙＝スキップ。スキップした画像は学習データに含まれません。
- 保存済みの表は、一覧から開くとそのまま再編集できます。
- 「直前の構造をコピー」を使うと、同じ様式の表を続けて作るときに便利です。
- 保存時には、結合の重なり、表からのはみ出し、見出しをまたぐ結合をチェックします。エラーがあると保存できません。

| 操作 | キー |
| --- | --- |
| 範囲選択 | ドラッグ / Shift+クリック / Shift+矢印（行番号・列記号のクリックで行・列全体） |
| 結合 / 解除 | M / U |
| 行を挿入（下 / 上） | R / Shift+R |
| 列を挿入（右 / 左） | C / Shift+C |
| 行を削除 / 列を削除 | Shift+Delete / Ctrl+Delete |
| 選択範囲の下端までを見出しにする | H |
| 元に戻す / やり直し | Ctrl+Z / Ctrl+Y |
| 保存 / 保存して次へ | Ctrl+S / Ctrl+Enter |
| 前の画像 / 次の画像 | PageUp / PageDown |
| 画像の拡大縮小・移動 | ホイール / ドラッグ（F: 全体、W: 横幅、1: 等倍） |

結合セルの中に行や列を挿入すると、Excelと同じように結合が広がります。
