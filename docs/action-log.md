# Action log

`drive` writes an `action-log.json` array with one entry for each step it runs. `demo` writes the same file inside its output directory. The entries describe what the director did and what it observed; they do not contain the value typed into a field.

## Time base and shared fields

All timestamps use milliseconds from `t0`, the page `load` that starts the driven run. A field ending in `AtMs` or named `atMs` is a timestamp in that clock. `settleMs` and the `ms` field on a `wait` entry are durations, also in milliseconds. `voiceStartMs` uses the same clock as the action it narrates.

Every entry has:

| Field | Meaning |
| --- | --- |
| `index` | Zero-based step index from the input step list. |
| `type` | One of `click`, `wait`, `type`, `hover`, `key`, or `activate`. |

Entries may also include `label`, `voiceLineId`, and `voiceStartMs` when the step has a label or narration. Native entries can include `app`, `ax`, and `settleReason` as described below.

## `click`

Web clicks include the CSS `selector`; native clicks use the target app and AX locator instead. The point is the achieved OS-screen position, and `boundingBox` is the target frame at click time.

| Field | Meaning |
| --- | --- |
| `selector` | Web selector, or the description of the native AX locator. |
| `startedAtMs` / `clickedAtMs` | Start of the choreographed move and time the click was posted. |
| `screenX` / `screenY` | Achieved screen point sent to the click helper. |
| `boundingBox` | `{x, y, width, height}` for the target. |
| `settleMs` | Milliseconds from the click until the result settled. |
| `app` / `ax` | Native app bundle id and AX locator, when applicable. |
| `settleReason` | Native settle result: for example `quiet`, `expect`, or `cap`. |

```json
{
  "index": 0,
  "type": "click",
  "selector": "#submit",
  "startedAtMs": 420,
  "clickedAtMs": 1180,
  "screenX": 640,
  "screenY": 420,
  "boundingBox": { "x": 600, "y": 390, "width": 80, "height": 40 },
  "settleMs": 250,
  "voiceLineId": "s0",
  "voiceStartMs": 900
}
```

## `wait`

`wait` records when the wait began and the requested duration. A native wait may include the app and the AX locator in `until` that it watched.

| Field | Meaning |
| --- | --- |
| `atMs` | Timestamp at which the wait started. |
| `ms` | Requested wait duration in milliseconds. |
| `app` / `until` | Native app bundle id and AX locator, when the wait watches an app. |

```json
{
  "index": 1,
  "type": "wait",
  "atMs": 1430,
  "ms": 1000
}
```

## `type`

Typing entries identify the field, timing, achieved focus point, and number of characters entered. They intentionally have **no `text` field**: literal input and keychain-resolved secrets never appear in the action log or zoom fragment.

| Field | Meaning |
| --- | --- |
| `selector` | Web selector, or the description of the native AX locator. |
| `startedAtMs` / `endedAtMs` | Start of the move toward the field and time the last character was entered. |
| `screenX` / `screenY` | Achieved screen point used to focus the field. |
| `boundingBox` | `{x, y, width, height}` for the field at focus time. |
| `characterCount` | Number of characters entered; the characters themselves are never recorded. |
| `settleMs` | Milliseconds from the last character until the result settled. |
| `app` / `ax` / `settleReason` | Native app, AX locator, and settle result, when applicable. |

```json
{
  "index": 2,
  "type": "type",
  "selector": "#email",
  "startedAtMs": 2600,
  "endedAtMs": 3400,
  "screenX": 510,
  "screenY": 300,
  "boundingBox": { "x": 450, "y": 280, "width": 220, "height": 40 },
  "characterCount": 17,
  "settleMs": 150
}
```

## `hover`

`hover` is a native-only entry. It records the AX target and the point where the cursor came to rest, but no click.

| Field | Meaning |
| --- | --- |
| `app` / `ax` | Target app bundle id and AX locator. |
| `selector` | Description of the AX locator. |
| `startedAtMs` / `hoveredAtMs` | Start of the move and time the cursor came to rest. |
| `screenX` / `screenY` / `boundingBox` | Achieved point and target frame in capture space. |
| `settleMs` / `settleReason` | Settle duration and native settle result. |

```json
{
  "index": 3,
  "type": "hover",
  "app": "com.example.app",
  "selector": "AXButton label=Settings",
  "ax": { "role": "AXButton", "label": "Settings", "match": "exact" },
  "startedAtMs": 3800,
  "hoveredAtMs": 4550,
  "screenX": 720,
  "screenY": 180,
  "boundingBox": { "x": 680, "y": 150, "width": 80, "height": 40 },
  "settleMs": 200,
  "settleReason": "quiet"
}
```

## `key`

`key` is a native-only entry. `keys` contains normalized chord names such as `cmd+shift+v`, never free text.

| Field | Meaning |
| --- | --- |
| `app` | Target app bundle id. |
| `keys` | Array of normalized key chord names. |
| `atMs` | Timestamp when the key event was posted. |
| `settleMs` / `settleReason` | Settle duration and native settle result. |
| `boundingBox` | Optional zoom target frame, when the step names one. |

```json
{
  "index": 4,
  "type": "key",
  "app": "com.example.app",
  "keys": ["cmd+shift+v"],
  "atMs": 4800,
  "settleMs": 100,
  "settleReason": "quiet"
}
```

## `activate`

`activate` is a native-only entry that brings an app to the front.

| Field | Meaning |
| --- | --- |
| `app` | App bundle id brought to the front. |
| `atMs` | Timestamp when activation was posted. |

```json
{
  "index": 5,
  "type": "activate",
  "app": "com.example.app",
  "atMs": 5000
}
```
