# Changelog

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
