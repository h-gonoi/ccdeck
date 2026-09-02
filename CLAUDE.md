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
セッションが居るときは本数を出して聞き返し、対話端末でなければ止まる。
承知の上で入れ替えるなら `./bin/ccdeck stop --force`。
殺したセッションは次の `start` で会話の続きから復元されるが、
**やりかけの作業は中断される**（打ちかけの入力も、実行中のツールも戻らない）。

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
  revive.js    落ちる前に台帳を書き、次の起動で前回の続きを起こす
  transcripts.js  CLI が残す会話記録の場所と ID を引く（引き継ぎ・復元・スマホの会話表示が使う）
  butler.js    執事。見立て（claude -p / codex exec、読み取り専用）→ 提案 → 承認 → 手順を渡す
web/
  main.js      画面の状態管理。state.panes が表示中の枠
  term.js      xterm.js の管理。複数ペインをここが持つ
  editor.js    CodeMirror。開いたときだけ動的 import する
menubar/
  main.swift   NSStatusItem の常駐アプリ
mobile/
  src/deck.ts  React Native 側の WebSocket・再接続・chat/text 購読・入力
  src/screens/ Lobby（部屋の絵＋住人一覧）・Room（会話・入力・承認）・Butler・Pair・Settings
  src/ui/Pixel.tsx  ドット絵の住人（View のランレングス描画）・枠・ボタン
  scene/scene.html  部屋の絵（canvas）。直したら `npm run scene` で src/scene/html.ts を生成し直す
  scene/sprites.json  住人の絵。scene.html と src/sprites.ts の両方が読む（片方だけ直すと別人になる）
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

### 落とせば PTY は必ず死ぬ。台帳だけは残す

`ccdeck stop` もサーバーの入れ替えも、走っている claude / codex を必ず殺す。これは避けようがない。
だから代わりに「何がどこで走っていたか」を `~/.ccdeck/sessions.json` に残し、
次の起動で `--resume` して起こし直している（`server/revive.js`）。決めごと:

- **台帳に載るのは「殺されて終わったもの」だけ。** × で閉じたものと自然に終わったものは載せない
  （勝手に生き返ると鬱陶しい）。判定は「Map に居て `exitCode === null`」の一点で足りる
- **`saveSync()` は `killAll()` より先に呼ぶ。** 会話 ID は CLI が生きている間しか引けない
- **復元では前回と同じセッション番号を使う。** 画面が覚えている枠割り（localStorage の
  `ccdeck.panes`）がそのまま効いて、並べ方まで戻る。`id` は復元専用で HTTP からは渡せない
- 消えた会話を `--resume` に渡すと CLI が即落ちする。`resumeAvailable()` で確かめてから渡す

会話 ID は `~/.claude/sessions/<PID>.json` から引く。`/clear` などで途中から変わるので、
60 秒ごとに読み直している。起動直後はまだ書かれていないので、5 秒後と 20 秒後にも拾いに行く。

### CSS の落とし穴

- `hidden` 属性は `display: flex` などに負ける。`[hidden] { display: none !important }` が要る
- grid の行は `grid-auto-rows: 1fr` だと中身で膨らむ。`minmax(0, 1fr)` を使う
- grid アイテムの `min-height` は既定 `auto`。`.stage` に `min-height: 0` がないと画面からはみ出す

### @xterm/headless は CommonJS

named import が使えない。`import xtermHeadless from '@xterm/headless'` してから分解する。

### メニューバーアプリに clone 先を決め打ちしない

`menubar/main.swift` は ccdeck 本体の場所を **`~/.ccdeck/deck-path`** から読む。
このファイルは `bin/install-menubar` が書く。無ければ PATH の `ccdeck` を探す。

**ここをパスの決め打ちに戻すと、自分以外の環境で動かなくなる。**
（実際 `~/projects/ccdeck/bin/ccdeck` を直書きしていて、clone 先が違う人では起動できなかった）

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

### 色の要らない相手に ANSI を送らない

スマホの読み取り画面（M1）は色を出さない。そこへ ANSI を送って受け手で装飾を剥がすと、
**カーソル移動で作られた横の間隔まで消える**（`Claude Code   v2.1.231` が
`Claude Codev2.1.231` になる）。桁を知っていて正しく組めるのは判定用の
headless xterm を持つサーバー側だけなので、`attach { mode: 'text' }` には
`screenText()` の結果を送る。受け手で剥がす実装に戻さないこと。

### 同じ場所を綴り違いで二重に数えない

macOS のファイルシステムは大文字小文字を区別しない。`~/projects` と `~/Projects` は
同じ場所なのに文字列としては別物で、**`realpath` も綴りを直してくれない**。
「最近使った」は cwd をそのまま記録するので、綴りが違うと**一覧に同じリポジトリが二つ並ぶ**。

`server/projects.js` の同一判定は `nodeKey()`（`dev:ino`）で行っている。
パスの文字列比較に戻さないこと。

同じ罠が **CLI の書く cwd** にもある。ccdeck が `~/projects/x` で立てたセッションを、
Claude Code は `~/Projects/x` と記録することがある。文字列で突き合わせると
**会話 ID を取り逃がし、復元しても続きから始まらない**。
`server/transcripts.js` の `sameDir()` も inode で見ている。

### プロジェクトの並びは二か所にある

「ピン → 最近使った順 → 名前」という順は `server/projects.js` の `compareProjects` と
`web/main.js` の `sortProjects` に同じものが書いてある。画面はセッションを立てた瞬間に
自分で並べ替え、再スキャンを待たない（`markRecent`）。**片方だけ直すと、
立てた直後と「更新」を押した後で順が食い違う。**

記録の入口は POST `/api/sessions` の `touchRecent` 一か所だけ。外部セッションでは記録しない。

### 番号の付かないダイアログも「要対応」

Claude Code の「このフォルダを信頼しますか」は `Do you want` も `1. Yes` も含まず、
`Enter to confirm` と `❯ No, exit` しか出ない。ここを `idle` と見ると、
**執事やスマホが「手が空いた」と思って Enter を送り、既定の「No, exit」で CLI が落ちる**（実際に落ちた）。
`sessions.js` の `PATTERNS.attention` に `Enter to confirm` を足してある。ダイアログの言い回しが増えたら、
まずここに足すこと。執事側は念のため `DIALOG` で画面を見てからしか手順を渡さない。

### スマホは古いサーバーにも繋がる

`attach { mode:'chat' }` を知らないサーバー（会話モードより前に起動したもの）は `replay` を返す。
スマホ側は `replay` が来たら会話を諦めて `text` に切り替える（`deck.ts` の `chatOk`）。
「会話が出ない」と言われたら、まずサーバーを入れ替えていないか疑うこと。
自分がいま動いているサーバーがディスク上のコードと同じとは限らない（`/api/health` の `buildId` は起動時刻）。

### 二つ目のサーバーは `CCDECK_HOME` で隔てる

試験用に別ポートで立てるとき、そのまま起こすと **本番の台帳（`~/.ccdeck/sessions.json`）を読んで
前回のセッションを二重に復元**してしまう。`CCDECK_HOME=/tmp/x CCDECK_PORT=7799 node server/index.js`
のように置き場ごと分けること。台帳・端末・履歴・執事の状態がすべてそこに入る。

### Expo Go の歯車と Maestro

Expo Go の開発メニューを開く丸いボタンが画面右上に居座り、そこに置いた「設定」を Maestro が叩けない。
テキストの上に別のビューが重なると Maestro はそちらを叩く。ロビーでは繋ぎ先の名前（中央）を押しても設定へ行けるので、
自動化ではそちらを叩く。行の中身は 1 つの accessibility 要素にまとまるので、`text: "probe, .*"` のように正規表現で当てる。

## 執事の決めごと

- **見立ては読み取り専用。** `claude -p --allowedTools <読むものだけ> --disallowedTools Edit,Write,…`、
  Codex は `exec --sandbox read-only`。ここを緩めると「見立て」のつもりで変更が入る
- **手順を渡すのは承認のあとだけ。** 一巡ごとに承認を挟む（`autoNext` は次の見立てを自動で始めるだけ）
- **承認待ち（attention）は人の仕事。** 執事は押さない。例外は自分で立てたセッションの信頼ダイアログだけ
- **手順は貼り付けとして渡す**（`ESC[200~ … ESC[201~` のあと少し置いて `\r`）。改行を送信と取られない
- **idle が 6 秒続いたら手順が終わったとみなす。** ツールの合間の一瞬の idle を終わりと見ないため
- 状態は `~/.ccdeck/butler.json`。サーバーを入れ替えると走っていた巡は `paused` になる。勝手に再開しない
- モデル: Claude は `claude-fable-5-1`（`models.claude`）、Codex は指定なし＝codex の設定に従う（`models.codex`）

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
5. サーバーを入れ替えたあと、前のセッションが同じ番号・同じ枠で戻るか
   （`~/.ccdeck/sessions.json` に載っていること、`vendorId` が埋まっていること）

スマホまわりを触ったら、これも見る（`mobile/` で `npm run typecheck`、絵を直したら `npm run scene`）。

- 呼ばれているセッションの部屋で、問いの箱が切り出されて「承認 ⏎ / 1 2 3 / Esc」が出ること
- 話しかけた文章がそのまま届き、送信されること（改行を含む文章も）
- 古いサーバー（`chat` 未対応）に繋いでも画面の文字で読めること

執事を触ったら、これも見る。

- 見立ての途中で何も変更されないこと（`git status` が見立て前後で同じ）
- 初めてのフォルダで立てたセッションが「信頼しますか」で落ちないこと
- 承認前に外した手順が渡されないこと。「止める」で以後の手順が渡されないこと

`--lan` まわりを触ったら、これも見る。

6. `--lan` なしの起動で、LAN のアドレスから一切繋がらないこと
7. トークンなしの LAN からの REST と WebSocket が 401 で落ちること
8. LAN から未対応の `agent` や `command` を指定しても任意コマンドが起動しないこと
9. 失効させたトークンが、その場で 401 になること
