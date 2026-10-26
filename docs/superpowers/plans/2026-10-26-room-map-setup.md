# 四人房间与地图准备阶段 Implementation Plan

**Status:** 已实现并完成验收（2026-10-26）。地图规则、房间服务与界面分别实现后，在本次会话统一集成和验证。

**Goal:** 四个浏览器进入同一房间，分配一名箱娃与三名访问者，由访问者轮流抽板并完成九块地图的合法拼接。

**Architecture:** Node.js HTTP 服务保存房间及地图状态，POST 执行动作，SSE 同步快照。浏览器以 SVG 呈现可旋转的地图板。规则模块单独测试，服务器始终校验角色、轮次与门的连接。

**Tech Stack:** Node.js 22+ 标准库、原生 JavaScript/CSS/SVG、Node test runner；Playwright 仅用于浏览器验收。

**Spec:** `docs/规则与首版范围.md`、`docs/地图资料.md`、`AGENTS.md`。

## Global Constraints

- 四名真人：一名箱娃、三名访问者；无机器人代替四人验收。
- 地图由访问者轮流抽板、旋转、摆放；九块全部配置后才完成地图准备阶段。
- 至少一扇门对接即可放置；另一相邻边是墙时不产生通路。
- 一楼大厅作为起点；二楼大厅与地下室单独配置；二楼大厅出现后才可将后续普通板接到二楼。
- 对照参考照片核对前景板的门，避免把叠在下面的板上的门计入。
- 本阶段终点是地图准备完成。道具、隐藏角落、无声模式对局的资料尚待补齐。
- 每个完成的改动单元都需测试通过并提交 Git commit。

## Shared interfaces

`src/maps.mjs` exports `MAP_TILES` (array) and `getTile(id)`. Each tile has `id`, `name`, `rooms` (id/name/shape/label/corners/haunted), `doors` (N/E/S/W to room id), `internalDoors`, and `stairs`. Geometry uses a 100×100 tile coordinate system; rotation is clockwise quarter-turns 0–3. Room ids are unique across all nine tiles. Tile ids: `hall`, `study`, `bathroom`, `dining`, `upstairs`, `basement`, `children`, `storage`, `living`.

`src/game.mjs` exports `createSetup(visitorIds, {deck} = {})`, `drawTile(game, playerId)`, `placeTile(game, playerId, {floor,x,y,rotation})`, `getLegalPlacements(game, rotation)`, `getConnections(placements)`, and `getSetupView(game)`. Mutations throw an Error for invalid actions. A setup view has `placements`, `drawnTileId`, `remaining`, `turnPlayerId`, `legalPlacements` (flat array for all four rotations), `connections`; the private deck is never exposed. Game phases: `map_setup`, `map_ready`. Floors: 1, 2, -1.

HTTP: `POST /api/rooms` body `{name}` and `POST /api/rooms/:code/join` body `{name}` return `{roomCode,playerId,token,state}`. `POST /api/rooms/:code/actions` body `{playerId,token,type,...}` supports `ready` (ready boolean), `set_hako` (targetId), `start`, `draw`, `place` (floor/x/y/rotation), `leave`. `GET /api/rooms/:code/events?playerId=...&token=...` emits SSE `state` events. `GET /api/rooms/:code?playerId=...&token=...` resumes a session.

A room snapshot: `{code,hostId,phase,players:[{id,name,role,ready,connected,seat}],you,setup,log,version}`. `setup` is null in lobby. Errors are `{error}` with non-2xx status. `/shared/maps.mjs` serves the browser-safe tile catalog. The room creator is initially host and hako; host can reassign hako before start. Start requires four ready players. Nicknames must be nonempty and at most 16 characters. Session tokens must not be in room snapshots. SSE reconnect updates connected presence.

## Task 1: Map rules and catalog

Files: `src/maps.mjs`, `src/game.mjs`, `tests/game.test.mjs`.

- [x] Cover the 9-tile/24-corner catalog, one-way door rejection, rotation, overlap, turn/role restrictions, floor prerequisites, and a complete eight-draw setup with tests.
- [x] Read reference photos and implement the public catalog plus the pure rules module.
- [x] Verify internal room doors, external aligned doors, and the two stair connections in the resulting graph.
- [x] Run the map tests and integrate into the verified milestone commit.

Example boundary assertion: `assert.throws(() => drawTile(game, 'hako'));` and ensure the private deck remains unchanged. A draw must not preselect a placement. A successful placement advances to the next visitor, skipping hako.

## Task 2: Room service and HTTP

Files: `src/server.mjs`, `server.mjs`, `tests/server.test.mjs`.

- [x] Cover four actual HTTP identities, an attempted fifth player, unauthorized tokens, ready/start, SSE updates, reconnect, and duplicate/stale actions with integration tests.
- [x] Implement an in-memory room service with random room codes and unguessable tokens; expose `createGameServer({deck} = {})` returning an unbound `http.Server` for tests.
- [x] Serve only the frontend files and the map catalog; return useful Chinese error messages.
- [x] Test disconnect cleanup and release timers/server connections at test end.
- [x] Run the room tests and integrate into the verified milestone commit.

Tests listen on an ephemeral localhost port and use `fetch`. A room code is a discovery identifier, while mutation authorization requires its participant's token.

## Task 3: Browser interface

Files: `public/index.html`, `public/style.css`, `public/app.js`, `public/tile.js`; browser tests owned by integration task.

- [x] Implement join/create forms, player seats, readiness, host hako assignment, and invitation copy.
- [x] Implement three floor tabs, a drawn-tile preview, rotation, legal placement targets, confirmation, progress, and completion state.
- [x] Preserve form focus while SSE updates arrive; use textContent for player input, sessionStorage for tab-specific identity, EventSource for reconnect.
- [x] Provide desktop and mobile layouts, keyboard focus, explicit labels, visible errors, and reduced-motion support.

Visual direction: Chinese haunted manor; warm paper board, ink-colored text, restrained cinnabar accents, dark wood surrounding table. The board and the active player's action are the primary focus.

## Task 4: Integration, verification, handoff

Files: `tests/browser.e2e.mjs`, `README.md`, `AGENTS.md` and existing progress notes.

- [x] Browser test four independent contexts completing a full nine-tile configuration; assert all views agree, reject non-current actions through HTTP tests, and verify refresh resumes the seat.
- [x] Capture desktop and mobile screens in one inspection pass, fix concrete issues, then confirm the affected cases.
- [x] Run `npm test`, `npm run test:browser`, `npm run verify:references`, `git diff --check` and staged-diff checks.
- [x] Update the handoff notes to the actual implemented milestone, record remaining card-dependent work, commit, and provide local/LAN startup instructions.

## Review correction

The independent review reproduced lost credentials when the authenticated resume request failed temporarily. The browser test first failed on this case; the fix preserves the identity for network/server failures and clears it only for confirmed 403/404 responses. The same four-browser test now covers retry by refresh and confirmed invalid identity handling, alongside the layout regressions found during visual inspection.
