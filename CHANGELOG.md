# Changelog

## 0.2.0 (unreleased)

The AI can show a picture when the story calls for it. Off by default.

- A function tool, `spicyapi_generate_image`, that chat models with tool calling can call with a description of the scene. The panel shows whether SillyTavern's function calling is on and can turn it on.
- A reply tag for chat APIs without tool calling: `<pic prompt="...">` (the tag name can be changed) is removed from the reply and the picture is posted right after it. A neutral instruction for the model can be added to the prompt automatically or copied.
- Limits for automatic pictures: at most one every N replies per chat, a daily limit kept in the browser, and a choice to ask or skip above the confirmation amount. The per-run limit still applies, and automatic runs only make pictures, never videos.
- Tests for the tag parser, the cooldown and the daily limit.

## 0.1.0 (unreleased)

First version.

- `/spicy-img`, `/spicy-video` (text to video, or `image=last` to animate a picture), `/spicy-task` and `/spicy-balance`.
- Wand menu entries and an Animate button on pictures in the chat.
- Prompts can be written by the connected chat model from the current scene and edited before generating.
- Picture, text-to-video and image-to-video models loaded live from the SpicyAPI catalogue, with prices, content policy and per-model settings.
- Every run is quoted first; a confirmation amount and a hard per-run limit guard spending.
- Results are saved in SillyTavern and attached to the chat, hidden from the AI by default.
- Optional character avatar as a reference picture.
- One-click setup of SillyTavern's Custom (OpenAI-compatible) chat source for SpicyAPI chat models.
- Direct browser connection, with SillyTavern's CORS proxy as an optional fallback.
