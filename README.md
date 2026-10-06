# SpicyAPI for SillyTavern

A [SillyTavern](https://github.com/SillyTavern/SillyTavern) extension that makes pictures and short videos with [SpicyAPI](https://spicyapi.ai) models from inside your chats, and connects SillyTavern's chat to SpicyAPI's chat models in one click.

- `/spicy-img` and `/spicy-video` commands, plus SpicyAPI entries in the wand menu.
- An **Animate** button on pictures in the chat: turns the picture into a video clip.
- No prompt? The chat model you are connected to writes one from the current scene, and you can edit it before anything is generated.
- Every run is priced first and shown in US dollars. You set the amount above which the extension asks before spending, and a hard limit per run.
- Results are saved into SillyTavern and attached to the chat, hidden from the AI by default.
- Optional: use the character's avatar as a reference picture, with models that accept one.

Last verified with SillyTavern 1.19.0 on 2026-10-06.

## Install

You need SillyTavern 1.19.0 or later, with `git` installed on the machine that runs SillyTavern, and a SpicyAPI account.

1. Open **Extensions** (the stacked cubes icon) and choose **Install extension**.
2. Paste `https://github.com/spicyapi-ai/sillytavern-spicyapi` and press **Install**.
3. Reload the page if SillyTavern asks you to.

To install by hand instead, clone this repository into `data/<your user>/extensions/` (just for you) or into `public/scripts/extensions/third-party/` (for every user) and reload SillyTavern.

## Set up

Open **Extensions > SpicyAPI**.

1. **API key.** Create one at [spicyapi.ai/console/keys](https://spicyapi.ai/console/keys) and paste it. We suggest a separate key for SillyTavern with a daily spending limit.
2. **Check connection.** Shows your balance when the key works.
3. **Models.** Pick a model for pictures, for videos from text, and for videos from a picture (Animate). Each list shows the starting price and groups models by content policy (Uncensored, Softened, Filtered), as published in the SpicyAPI catalogue. Leave **Automatic** to use the cheapest Uncensored model. Under each model you can change its main settings (aspect ratio, resolution, length, audio); settings marked `$` change the price, and the full price table is one click away.
4. **Spending.** See [Prices and spending protection](#prices-and-spending-protection).

### Connection route

By default the extension talks to `https://api.spicyapi.ai` directly from your browser. If your network or browser blocks that, open **Connection** in the panel and choose:

- **Auto**: tries directly and falls back to SillyTavern's CORS proxy for any address that cannot be reached.
- **Through SillyTavern's CORS proxy**: always uses the proxy.

The proxy is off by default. Turn it on by setting `enableCorsProxy: true` in SillyTavern's `config.yaml` (or start SillyTavern with `--corsProxy`) and restart SillyTavern. The proxy cannot be used together with SillyTavern's basic authentication (`basicAuthMode`), because basic authentication rejects requests that carry an API key; use the direct route in that case.

## Use it

### Commands

| Command | What it does |
| --- | --- |
| `/spicy-img [prompt]` | Makes a picture and posts it to the chat. Without a prompt, the connected chat model writes one from the scene. |
| `/spicy-video [prompt]` | Makes a video from text. |
| `/spicy-video image=last [prompt]` | Animates the most recent picture in the chat. `image=` also takes a picture URL. |
| `/spicy-task <task id>` | Adds the result of an earlier task to the chat, for example after **Stop waiting** or a page reload. |
| `/spicy-balance` | Returns your available balance in USD. |

Named arguments:

- `model=<id>` picks a model for this run only, for example `model=alibaba/z-image-turbo/text-to-image`. Press Tab after `model=` for the list.
- `edit=true` opens the prompt editor even when you typed a prompt.
- `quiet=true` saves the result and returns its path without posting it, for Quick Replies and STscript.
- `avatar=true` or `avatar=false` (pictures only) overrides the "use the character avatar" setting.

Examples:

```
/spicy-img a lighthouse on a cliff at dusk, wide shot
/spicy-video waves rolling onto a beach at sunrise
/spicy-video image=last slow push-in, hair moving in the wind
```

### Wand menu and the Animate button

The wand menu (next to the chat input) has **SpicyAPI picture**, **SpicyAPI video** and **SpicyAPI: animate last picture**.

Every picture in the chat has a film icon among its controls, and messages with a picture have the same icon in their **...** menu. It animates that picture with your image-to-video model and adds the clip to the same message.

### The prompt editor

With **Let me read and edit the prompt before generating** on (the default), runs without a typed prompt open an editor. It shows the model and the exact price, and the connected chat model starts writing a prompt from the scene; you can wait for it, type your own, or press **Write from the scene** again. The extension itself ships no prompts, presets, styles or example content: the words come from you or from your chat model.

### Where results go

Results are downloaded and saved into SillyTavern's image folder (`data/<user>/user/images/<character>/spicyapi_<task id>.png` or `.mp4`), then attached to the chat. New messages are hidden from the AI by default, so the next chat request does not send pictures to a model that cannot read them. Turn on **Let the AI see generated pictures and videos** to change that.

If you switch chats while something is generating, the result is saved but not added to the chat; the extension tells you where it is.

## Chat with SpicyAPI models

**Connect chat** in the panel does the setup for you: it selects **Chat Completion > Custom (OpenAI-compatible)** in API Connections, sets the endpoint to `https://api.spicyapi.ai/v1`, saves your key as that endpoint's API key and selects the chat model you picked.

To do it by hand:

1. Open **API Connections** (the plug icon). Set **API** to **Chat Completion** and **Chat Completion Source** to **Custom (OpenAI-compatible)**.
2. **Custom Endpoint (Base URL)**: `https://api.spicyapi.ai/v1` (no trailing slash, no `/chat/completions`).
3. **Custom API Key**: your SpicyAPI key.
4. **Enter a Model ID**: a chat model id, which ends in `/chat`, for example `deepseek/v4-flash/chat`. The model dropdown lists every SpicyAPI model, including picture and video models, which cannot chat.
5. Press **Connect**.

Tips:

- Turn on **Streaming**. Long answers without streaming can time out, and SillyTavern only shows "Bad Request" for errors on non-streamed requests, while streamed requests show SpicyAPI's own error message.
- Reasoning models count their thinking against **Response (tokens)**. Set it to 2000 or more if answers come back empty or cut off.
- Sampling settings a model does not support are ignored rather than rejected.

## Prices and spending protection

- Before every run the extension asks SpicyAPI for a quote. Quotes are free and nothing is charged.
- **Ask before spending more than**: runs above this amount (default $0.10) need a confirmation. When the prompt editor already showed the price, pressing **Generate for $...** counts as that confirmation. Leave it empty to never ask; 0 asks every time.
- **Never spend more than**: runs that could cost more than this amount (default $1.00) are refused before anything is charged. Leave it empty for no limit.
- The panel shows what this browser session has spent.
- A submitted run keeps going on SpicyAPI even if you press **Stop waiting** or close the page, and it is billed if it succeeds. Use `/spicy-task <task id>` to collect it later.
- Failed runs are normally not charged. Some models charge for refused requests; their model page on spicyapi.ai says so.
- Errors are shown with SpicyAPI's own message and request id, which support can look up.

## Privacy

- **Your API key** is stored in SillyTavern's settings file on the machine that runs SillyTavern (`data/<user>/settings.json`, under `extension_settings.spicyapi`), in plain text. Other SillyTavern extensions can read it. If you use **Connect chat**, the key is also saved in SillyTavern's secrets file as the Custom endpoint key.
- **What leaves your machine**: the prompt, the model settings and any reference picture (the character avatar, or the picture you animate) go to `api.spicyapi.ai`, through SillyTavern's proxy if you chose that route. When the chat model writes the prompt, the chat context goes to whichever chat API SillyTavern is connected to, as with any other message.
- **Results** are stored in SillyTavern's own image folder on your machine. SpicyAPI keeps generated files for a limited time; see the privacy policy on [spicyapi.ai](https://spicyapi.ai).
- The extension sends no analytics and talks to nothing but SpicyAPI and your own SillyTavern server.

## Troubleshooting

- **"The browser could not reach api.spicyapi.ai (network error or CORS)"**: something between your browser and SpicyAPI blocks the request. Switch the connection route to **Auto** and enable SillyTavern's CORS proxy as described above.
- **"SillyTavern's CORS proxy is turned off"**: set `enableCorsProxy: true` in `config.yaml` and restart SillyTavern, or switch back to **Direct**.
- **"The result ... is ready, but it could not be downloaded"**: run `/spicy-task <task id>` to try again. If it keeps failing, use the **Auto** route with the CORS proxy enabled.
- **The prompt could not be written**: no chat model is connected, or it returned an error. Type a prompt instead.

More about the API: [docs.spicyapi.ai](https://docs.spicyapi.ai).

## Development

The extension is plain JavaScript modules with no build step and no dependencies. The tests cover the API client and the catalogue logic and run under Node 20 or later:

```
npm test
```

## License

[MIT](LICENSE)
