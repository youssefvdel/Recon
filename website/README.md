# Recon — Official Website & Landing Page

Official responsive landing page for **Recon**, the Esport-Grade Stretched Resolution & Real-Time Scout Utility for Valorant.

🌐 **Live URL**: [https://reconlab.app](https://reconlab.app) (or [https://youssefvdel.github.io/](https://youssefvdel.github.io/))  
⚡ **App Repository**: [https://github.com/youssefvdel/Recon](https://github.com/youssefvdel/Recon)

---

## 🚀 Features

- **Cyber/Esports Visual Identity**: Deep space violet `#0c0714`, Material Design 3 tokens, glassmorphic HUD overlays, and glowing accent highlights.
- **Interactive Stretched Simulator**: Real-time slider demonstrating target expansion under 16:10 and 4:3 stretched aspect ratios.
- **Interactive Live Preview Tabs**: Real app previews of the Material 3 Collection & Arsenal, transparent In-Game Scout HUD, and True Stretched display scaling.
- **100% Vanguard Safety Section**: Technical breakdown addressing anti-cheat compliance, zero memory injection, and official Riot Client loopback API usage.
- **Automated Deployment**: GitHub Actions workflow (`.github/workflows/deploy-website.yml`) builds and deploys directly to GitHub Pages on every push to `main`.
- **Instant Confetti Download CTA**: Directly downloads signed `Recon_0.3.2_x64-setup.exe` from GitHub Releases.

---

## 🛠️ Local Development

Built with **Vite**, **React 19**, **TypeScript**, **Tailwind CSS**, and **Framer Motion**.

```bash
# 1. Install dependencies
bun install

# 2. Run local dev server
bun run dev

# 3. Production build
bun run build
```

---

## 🌐 Custom Domain Setup (`reconlab.app`)

This site uses the `reconlab.app` domain, with DNS pointing at GitHub Pages.

### Step-by-Step Configuration

1. **Register the Domain**:
   - Register `reconlab.app` with your registrar.

2. **Configure DNS Records**:
   - In your DNS manager:
      - **Record Type**: `CNAME`
      - **Host / Name**: `@` (or `recon`)
      - **Target**: `youssefvdel.github.io`
      - **TTL**: Automatic (or 300)

3. **Verify in GitHub Pages**:
   - The repository includes a `website/public/CNAME` file pointing to `reconlab.app`.
   - In repository **Settings → Pages**:
     - Custom domain: `reconlab.app`
     - Check **Enforce HTTPS** (issued automatically by Let's Encrypt).
