# ccdeck

複数の Claude Code / Codex セッションを一画面で束ねるツール。
Cursor を複数ウィンドウ開くのが重いという動機で作った。**軽さが最優先の価値**なので、
機能を足すときは常駐コストとの釣り合いを見ること。参考値は README の実測表にある。

## 開発の回し方

```sh
npm run build                        # web/ → dist/
./bin/ccdeck stop && ./bin/ccdeck start
```

**`ccdeck stop` は走っている claude セッションも道連れに殺す。**
サーバーを入れ替える前に、消して困るセッションがないか確認すること。

画面だけの修正なら `npm run build` のあと、開いている画面を ⌘R すれば足りる。
サーバーを再起動した場合は、起動 ID が変わるので画面が自分でリロードする（`BUILD_ID`）。

メニューバー常駐アプリを直したときは:

```sh
cd menubar && swiftc -O -o ccdeckbar main.swift -framework Cocoa
cp ccdeckbar ~/Applications/ccdeck.app/Contents/MacOS/ccdeck
codesign --force --deep --sign - ~/Applications/ccdeck.app
pkill -f "ccdeck.app/Contents/MacOS/ccdeck" && open ~/Applications/ccdeck.app
```

## 構成

```
server/
  index.js     Express + WebSocket。API と静的配信。BUILD_ID もここ
  sessions.js  PTY の生成・保持と状態判定（このアプリの心臓）
  external.js  ccdeck 以外で立てられたセッションの検出とターミナル前面化
  auth.js      LAN に出すときの関所（トークン・端末台帳・記録）
  git.js       git コマンドのラッパ
  projects.js  リポジトリの自動スキャンと「最近使った」順（~/.ccdeck/recent.json）
  files.js     ファイル読み書き（プロジェクト外は拒否する）
web/
  main.js      画面の状態管理。state.panes が表示中の枠
  term.js      xterm.js の管理。複数ペインをここが持つ
  editor.js    CodeMirror。開いたときだけ動的 import する
menubar/
  main.swift   NSStatusItem の常駐アプリ
mobile/
  src/deck.ts  React Native 側の WebSocket・再接続・snapshot 購読
  src/screens/ M1 のペアリング・一覧・読み取り画面・設定
```

## 踏んだ落とし穴（同じ穴を掘り直さないこと）

### 状態判定に「出力の有無」を使ってはいけない

Claude Code は**待機中もステータスラインを更新し続ける**（`/rc connecting…` など）。
そのため「出力がある＝実行中」は成立せず、状態が数百 ms ごとにフラップする。

出力は再評価のきっかけにだけ使い、状態は headless な xterm に食わせた
**実際に描画された画面の中身**から判定している（`sessions.js` の `PATTERNS`）。
判定を触るときはこの前提を壊さないこと。

### 子セッション扱いを避けるための環境変数の掃除

`CLAUDE_CODE_CHILD_SESSION` などを継承したまま `claude` を起動すると、
「Transcript saving is off」になり、**`~/.claude/sessions/*.json` にも登録されない**。
登録されないと外部セッションとして検出できない。
`sessions.js` の `POISON_ENV` を必ず落としてから spawn すること。

### replay はサイズを確定させてから流す

xterm のサイズが決まる前に replay を流すと、80 桁で描かれた内容が広い画面に流れて
TUI の枠が崩れる。`syncPanes()` は **setVisible（fit して resize 送信）→ attach（replay 受信）**
の順を守っている。この順序を入れ替えないこと。

### CSS の落とし穴

- `hidden` 属性は `display: flex` などに負ける。`[hidden] { display: none !important }` が要る
- grid の行は `grid-auto-rows: 1fr` だと中身で膨らむ。`minmax(0, 1fr)` を使う
- grid アイテムの `min-height` は既定 `auto`。`.stage` に `min-height: 0` がないと画面からはみ出す

### @xterm/headless は CommonJS

named import が使えない。`import xtermHeadless from '@xterm/headless'` してから分解する。

### メニューバー起動時の Node をターミナルと揃える

メニューバーアプリの login shell は Homebrew の Node を拾うことがあり、ターミナルで npm install した
`node-pty` と ABI が食い違う。`bin/ccdeck` は `~/.nvm/alias/default` の Node を優先している。
ここを単なる `node server/index.js` に戻すと、メニューバーからだけ `ERR_DLOPEN_FAILED` になる。

### LAN に出すときの関所を素通ししない

`--lan` を付けると PTY を作れる口が LAN に開く。**ここを緩めると、
その Wi-Fi にいる全員にシェルを配ることになる。** 触るときの決めごと:

- **ループバックは素通し、それ以外はトークン。** 判定は `auth.identify()` 一か所。
  `X-Forwarded-For` の類は見ない（詐称できる）
- **`POST /api/sessions` は `command` を受けず、`agent` を固定コマンドへ変換する。**
  ここを「便利だから」と緩めると LAN 越しの任意コマンド実行になる
- WebSocket は `server.on('upgrade')` で**通す前に**確かめる。
  `verifyClient` を使わないのは、断るときに 401 を返したいため
- `devices.json` に平文のトークンを書かない。持つのは SHA-256 だけ
- 台帳を読み終える前に listen しない（`await auth.ready`）。
  読み込み前のリクエストは登録済みの端末まで弾いてしまう

記録は `~/.ccdeck/audit.log`。**打鍵の中身は残さない**（パスワードが混ざる）。
セッションごとに「触り始めた」ことだけ一度書く。

### 同じ場所を綴り違いで二重に数えない

macOS のファイルシステムは大文字小文字を区別しない。`~/projects` と `~/Projects` は
同じ場所なのに文字列としては別物で、**`realpath` も綴りを直してくれない**。
「最近使った」は cwd をそのまま記録するので、綴りが違うと**一覧に同じリポジトリが二つ並ぶ**。

`server/projects.js` の同一判定は `nodeKey()`（`dev:ino`）で行っている。
パスの文字列比較に戻さないこと。

### プロジェクトの並びは二か所にある

「ピン → 最近使った順 → 名前」という順は `server/projects.js` の `compareProjects` と
`web/main.js` の `sortProjects` に同じものが書いてある。画面はセッションを立てた瞬間に
自分で並べ替え、再スキャンを待たない（`markRecent`）。**片方だけ直すと、
立てた直後と「更新」を押した後で順が食い違う。**

記録の入口は POST `/api/sessions` の `touchRecent` 一か所だけ。外部セッションでは記録しない。

## 外部セッションの扱い

`~/.claude/sessions/<PID>.json` を読んでいる。Claude Code 自身が書くので、
ターミナルからでも Cursor の内蔵ターミナルからでも拾える。

| ファイルの status | ccdeck の表示 |
|---|---|
| `busy` | 実行中 |
| `waiting` + `waitingFor: "input needed"` | 要対応 |
| `idle` | 待機 |

**入力は送れない。** PTY を持っているのは向こうのターミナルであり、横取りすると両方壊れる。
代わりに tty から Terminal.app / iTerm のウィンドウを前面に出している。
Cursor の内蔵ターミナルは AppleScript で触れないので、そこは諦めてトーストで伝える。

生存判定は PID だけでなく、必要なら JSON の `procStart` と `ps` の起動時刻を突き合わせること
（PID 再利用への備え）。

## デザインの決めごと

- **琥珀（`--amber`）は「あなたの番です」にだけ使う。** 他の用途に広げると信号が薄まる
- 実行中は控えめな緑。待っていればいいものは目立たせない
- カードで囲まない。区切りは余白とボーダーで表す
- 角丸は 3px で統一
- モーダルは出さない。確認は行の中かメニューの中で二段階にする

## Agent の引き継ぎ

チャット上部の agent ボタンは、同じ `familyId` の Claude Code / Codex セッションを切り替える。
相手がまだなければ、元セッションのローカル transcript を共通テキストへ変換して初回プロンプトに添え、
同じ cwd で立ち上げる。transcript を特定・解析できない場合だけ現在画面へフォールバックする。
ベンダー固有のセッション状態そのものではなく、「変換 transcript＋ファイル・git 状態」の引き継ぎである。
HTTP からプロンプトやコマンドを受け取らず、サーバー内で組み立てる前提を崩さないこと。

## 変更時に確認すること

セッションまわりを触ったら、最低限これを見る。

1. 起動直後にフラップしないか（`starting → idle` の一度きりであること）
2. 承認待ちが `attention` になるか（`claude --permission-mode default` で作ると再現しやすい）
3. 12 枠に並べたとき画面からはみ出さないか
4. 画面を開き直して枠が復元されるか（localStorage の `ccdeck.panes`）

`--lan` まわりを触ったら、これも見る。

5. `--lan` なしの起動で、LAN のアドレスから一切繋がらないこと
6. トークンなしの LAN からの REST と WebSocket が 401 で落ちること
7. LAN から未対応の `agent` や `command` を指定しても任意コマンドが起動しないこと
8. 失効させたトークンが、その場で 401 になること
