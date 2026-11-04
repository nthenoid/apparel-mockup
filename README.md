# Apparel mockup tool

An in-house tool that puts a logo on a shirt automatically and at true size. Upload a PNG, JPG, SVG, AI, PDF or EPS, enter the print width in inches, and it places the art in the standard spot for the garment, scaled to that garment's real measurements. Change colors, styles, sizes and front/back freely; your size and any position adjustments carry over.

It runs as one Docker container on Unraid, reached through Cloudflare Tunnel and protected by Cloudflare Access.

## How it works

- **Garment detection.** The tool finds the shirt's outline in the product photo, then measures the center line, the top of the shoulder and the body width just below the armpit. It measures on the darkest color of each style, because every color of a style is photographed the same way.
- **True size.** Body width in pixels divided by the size chart's body width gives pixels per inch. Body length is used as a cross-check, and as the fallback if width doesn't match the chart. Choosing "Show on size" rescales the print to show how it looks on that size.
- **Standard placements.** Full front, center chest, left chest, full back and upper back, with rules per garment type (tees, polos, tanks, hoodies). Hoodies warn when a print runs into the pocket.
- **Saved corrections.** If a style lands slightly off, drag the logo (or use the arrow keys), then choose **Save for this style**. That correction applies to every color of that style from then on.

Until S&S is connected, the tool shows three sample garments drawn to known measurements so you can try everything.

## 1. Put the code in your personal GitHub repository

1. On GitHub, signed in to your personal account, create a new **private** repository named `apparel-mockup`. Don't add a README or license.
2. Upload this folder to it. The simplest way is [GitHub Desktop](https://desktop.github.com): choose **Add existing repository**, pick this folder, publish it to your new repository.
   Or from a terminal in this folder:
   ```bash
   git init -b main
   git add .
   git commit -m "Initial version"
   git remote add origin https://github.com/YOUR-GITHUB-USERNAME/apparel-mockup.git
   git push -u origin main
   ```
   Make sure the hidden `.github` folder is included. Dragging files into the GitHub website can skip it.

## 2. Let GitHub build the container

Pushing to `main` starts the **Test and build image** workflow (see the **Actions** tab). When it finishes, the image is at `ghcr.io/YOUR-GITHUB-USERNAME/apparel-mockup:latest`.

Unraid needs permission to download it. Pick one:

- **Make the image public** (simplest). On GitHub, go to your profile, **Packages**, `apparel-mockup`, **Package settings**, and change visibility to public. The code repository stays private. The image contains no keys or passwords; those live only in your Unraid settings.
- **Keep the image private.** Create a GitHub personal access token with only `read:packages`, then on Unraid run `docker login ghcr.io -u YOUR-GITHUB-USERNAME` and paste the token. Unraid forgets this on reboot, so add the login to a script that runs at array start (the User Scripts plugin works well).

Turn on Dependabot alerts and security updates under the repository's **Settings**, **Code security**. Dependabot then suggests updates to the base image and build tools; approve them and the image rebuilds.

## 3. Set up Cloudflare Access first

Do this before creating the tunnel hostname, so the address is never reachable without a login. (The tool also refuses requests without a valid Access login, so it fails closed either way.)

1. In the Cloudflare dashboard, open **Zero Trust**, then **Access**, **Applications**, **Add an application**, **Self-hosted**.
2. Application domain: `mockups` on your business domain.
3. Add a policy: **Allow**, include **Emails**, and list the people who should have access. If your business uses Google Workspace or Microsoft 365, you can add that as a login method under **Settings**, **Authentication** to require those accounts.
4. Save. On the application's **Overview** tab, copy the **Application Audience (AUD) tag**.
5. Note your team domain, listed in Zero Trust **Settings**. It looks like `yourteam.cloudflareaccess.com`.

## 4. Run it on Unraid

1. Open the Unraid terminal and prepare the data folder:
   ```bash
   mkdir -p /mnt/user/appdata/apparel-mockup
   chown -R 99:100 /mnt/user/appdata/apparel-mockup
   ```
2. Copy the template into place, replacing `YOUR-GITHUB-USERNAME` inside it first:
   ```bash
   cp apparel-mockup.xml /boot/config/plugins/dockerMan/templates-user/my-apparel-mockup.xml
   ```
   (Upload `unraid/apparel-mockup.xml` to your server first, for example through a share.)
3. In Unraid, go to **Docker**, **Add Container**, and pick `apparel-mockup` from the template list.
4. Fill in the Cloudflare team domain and AUD tag. Leave the S&S fields empty for now if you want to start with the sample garments.
5. Apply. The container log should say `Mockup tool listening on port 8080`.

The template runs the container as Unraid's standard `nobody` user, with a read-only file system, no extra privileges and a 1 GB memory cap. Only `/data` is writable.

## 5. Add the tunnel hostname

In **Zero Trust**, **Networks**, **Tunnels**, open your existing tunnel and add a public hostname (newer dashboards call it a published application route):

- Subdomain `mockups`, your business domain
- Service `http://YOUR-UNRAID-IP:8080`

If your business domain is in a different Cloudflare account from the tunnel, create a second tunnel in that account and run a second `cloudflared` container with its token.

Open `https://mockups.yourbusiness.com`. You should get the Access login, then the tool. Opening the Unraid IP directly shows "Access denied", which is expected.

## 6. Connect S&S Activewear

1. Get your API key from the account page on ssactivewear.com. Your account number is the username.
2. In the container settings, fill in the account number and API key, then click Apply.
3. In the tool, under **Style**, type in **Add a style from S&S**: a brand and style number (`Gildan 5000`), a style number alone, or words from the name (`hooded`). Click **Add** next to the one you want. Its photos and size chart download once (a minute or two for a style with many colors) and stay saved on the server.
4. To drop a style you no longer use, select it and click **Remove this style**. You can add it back any time.

Every night at the hour you set, the tool refreshes the styles you've added (new colors, updated photos). It doesn't call S&S while you work.

**S&S styles** in the container settings is optional: a comma-separated starting list (`Gildan 5000, BELLA+CANVAS 3001`) that's loaded the first time only. After that, the list in the tool is what counts.

The header of the tool shows how many styles you have, when they were last refreshed, and any starting-list names S&S didn't recognize.

The tool only reads from S&S. It has no code for orders, so the key can't be used to place one through this tool.

**Check after the first sync.** The S&S size-chart response is read by matching names like "Body Width" and "Body Length", because that part of their API wasn't available to test against while building this. If a style shows "No size chart for this style, so typical measurements are used", open `/mnt/user/appdata/apparel-mockup/catalog.json`, or call `https://api.ssactivewear.com/v2/specs/?style=STYLEID` with your key, and adjust `classify()` in `server/catalog.js` to match the names S&S uses.

## 7. Updates

- **Automatic rebuilds.** Every Monday, GitHub rebuilds the image from scratch with the latest patched base system, Node and Ghostscript. Any change you push to `main` also rebuilds it.
- **Automatic installs.** Install **Auto Update Applications** from Community Applications and enable it for `apparel-mockup` (and for `cloudflared`). Or update manually from the Docker tab when it shows an update.
- **Your part.** Approve Dependabot's suggested updates when they appear, keep Unraid itself updated, and review the Access policy when staff change.

## Using the tool

- **Photo shows size.** Suppliers usually photograph one sample size. The tool assumes L for adult styles and M for ladies' and youth. If you measure a blank and find a style's photo shows a different size, change it here; it's saved for that style.
- **Artwork.** SVG, AI, PDF and EPS stay sharp at any size. For PNG and JPG, the tool warns below 150 pixels per inch at the print size. JPGs and PNGs with white backgrounds can have white removed around the art only, or everywhere including inside letters.
- **Illustrator files** must be saved with "Create PDF Compatible File" turned on (the default). If one won't convert, export it as SVG or PNG.
- **Uploaded artwork** is never stored. Raster and SVG files stay in your browser; AI, PDF and EPS files are converted in a temporary folder that's deleted immediately.
- **Placement rules** (inches below the shoulder, offsets, default widths) are in `public/layout.js` if you want to change your shop's standards.

## Testing on your own computer

With Node 22 installed:

```bash
npm test
npm run dev    # opens on http://localhost:8080 with the Access check turned off
```

Converting AI, PDF and EPS locally also needs Ghostscript installed. Never set `DISABLE_ACCESS_CHECK=true` on the server.
