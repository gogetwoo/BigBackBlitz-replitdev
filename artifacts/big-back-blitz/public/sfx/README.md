# Gameplay SFX assets

Non-voice sound assets used by `src/game/audioManager.ts`.

| File              | Used by                                     | Source / License |
| ----------------- | ------------------------------------------- | ---------------- |
| `coin.wav`        | `playCoinPickup()`                          | Synthesized in-house |
| `boost_loop.ogg`  | `startBoostLoop()` / `stopBoostLoop()`      | OpenGameArt — ["racing car engine sound loops"](https://opengameart.org/content/racing-car-engine-sound-loops) by BlackCortex (CC0 / Public Domain), originally cut from a [pdsounds.org public-domain recording](http://www.pdsounds.org/sounds/start_up_car_with_seat_belt_warning_beep). Loop #2 from the pack, converted to mono 44.1 kHz Ogg Vorbis (`-q:a 2`) for the web. |

Voice-acted announcer clips live in `announcer/` — see that folder's README.
