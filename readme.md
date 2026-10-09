<p align="center">
  <a href="https://agentsinthecloud.com/">
    <img src="docs/readme/logo.png" alt="AgentsInTheCloud — made for humans" width="340">
  </a>
</p>

- Run cloud coding agents on your own server
- Use any model provider you want
- Workflows optimized for evaluating agent work
- Free, [MIT licensed](LICENSE)

<p align="center">
  <a href="https://agentsinthecloud.com/">Website</a> · <a href="#installation">Install AgentsInTheCloud</a> · <a href="#frequently-asked-questions">FAQ</a>
</p>

## See AgentsInTheCloud in action

Click a video preview to watch on Tella, or [watch the embedded videos on the website](https://agentsinthecloud.com/).

### Elevator pitch

<a href="https://www.tella.tv/video/vid_cmtrgqf7l01fh0agmatvu18vg">
  <img src="docs/readme/elevator-pitch.jpg" alt="Watch the AgentsInTheCloud elevator pitch — give it a try" width="270">
</a>

[**▶ Play elevator pitch**](https://www.tella.tv/video/vid_cmtrgqf7l01fh0agmatvu18vg)

### Remote development experience

[![Watch: Remote development experience](docs/readme/remote-development-experience.jpg)](https://www.tella.tv/video/vid_cmtmxa27u00bg0agm0c3bd8sg)

### Evaluating agent work

[![Watch: Evaluating agent work](docs/readme/evaluating-agent-work.jpg)](https://www.tella.tv/video/vid_cmtmwk9k9014l0agm0lhybqop)

### Fire & forget for mental bandwidth

[![Watch: Fire & forget for mental bandwidth](docs/readme/fire-forget-for-mental-bandwidth.jpg)](https://www.tella.tv/video/vid_cmtmzsz8a000g0agm91cw4c07)

### On my phone?

[![Watch: On my phone?](docs/readme/on-my-phone.jpg)](https://www.tella.tv/video/vid_cmtn3k1e000sv09gmerlba9rl)

### Mini quality of life features

[![Watch: Mini quality of life features](docs/readme/mini-quality-of-life-features.jpg)](https://www.tella.tv/video/vid_cmtn2ej0a019209gm2ds97gin)

### Secrets

[![Watch: Secrets](docs/readme/secrets.jpg)](https://www.tella.tv/video/vid_cmtn16hh401gg0agm2k3z59br)

### Are cloud agents a good idea for me?

[![Watch: Are cloud agents a good idea for me?](docs/readme/are-cloud-agents-a-good-idea-for-me.jpg)](https://www.tella.tv/video/vid_cmtmuv6vb000s0bgmfkq1aw6h)

### Installing AgentsInTheCloud

[![Watch: Installing AgentsInTheCloud](docs/readme/installing-agents-in-the-cloud.jpg)](https://www.tella.tv/video/vid_cmtn2t2ic00g80agm1wce4yvs)

## Installation

1. **Connect to your server.** SSH into a Linux server that will only be used for AgentsInTheCloud.
2. **Install AgentsInTheCloud.** Run:

   ```sh
   curl -fsSL https://agentsinthecloud.com/install.sh | bash
   ```

## Frequently asked questions

<details>
<summary>Where do the cloud agents run?</summary>

On your own Linux computer. Rent one from Hetzner, or use an old machine you have laying around.

</details>

<details>
<summary>How beefy should the Linux machine be?</summary>

I use 8 CPU, 16 GB of memory, and a 320 GB disk in a data center that’s relatively close. Bigger is better, but it’s easy to scale up later.

</details>

<details>
<summary>Why does AgentsInTheCloud use Tailscale?</summary>

AgentsInTheCloud has access to your code and development tools, so it shouldn’t be open to the internet. Tailscale makes it easy to keep it accessible only to you.

</details>

<details>
<summary>How do I install project dependencies?</summary>

You can give each workspace template its own Dockerfile. Use it to install the versions of Node, Bun, Python, native libraries, or anything else your project needs.

</details>

<details>
<summary>Which models can I use?</summary>

All of them. You can use your OpenAI subscription, Anthropic API key, OpenRouter, etc.

</details>
