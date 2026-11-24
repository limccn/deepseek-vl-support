# Brand assets

The icon is a crop of the character that used to appear on this project's banner (the
light-haired girl with the "VL" sleeve badge).

**The original banner artwork is no longer in the working tree** — it was removed to keep
the repository small, but it is still in git history: find the deletion with
`git log --diff-filter=D -- docs/banner/banner.png`, then

```bash
git show <deletion-commit>^:docs/banner/banner.png > banner-original.png
```

recover the full-resolution file if you need to re-cut the icon.

## Files

| File | Size | Used by |
|---|---|---|
| `icon-512.png` | 512×512, 122 KB, palette + tRNS | **master copy** — regenerate the smaller sizes from this |
| `icon-128.png` | 128×128, 13 KB | README + zh-CN README header (displayed at 96 px) |
| `icon-32.png` | 32×32, 2 KB | favicon-sized contexts |

There is no vector source: the artwork is raster, so 512 is the largest surviving copy
(the crop it came from was 436 px, upscaled). Redraw in vector only if the character is
ever redrawn — and re-cut the master at the same time.

## Palette

| Token | Value | Use |
|---|---|---|
| ink | `#0A0E1A` | background |
| ink-2 | `#121A2E` | panels |
| line | `#22304D` | grid, borders |
| fg | `#E8EEF9` | primary text |
| muted | `#8FA3C0` | secondary text |
| accent | `#4FC3F7` | cyan sampled from the artwork — badges, glow |
| amber | `#FFB454` | status accents (sunset badge) |

Text on `ink` clears 4.5:1 for all combinations used (`fg` 15.4:1, `muted` 7.1:1,
`accent` 8.9:1).

## Regenerating

`sharp` / `sharp-cli` are used one-off; neither is a dependency of this package. Run from
the repo root.

### Smaller icon sizes

```bash
npx -y sharp-cli -i docs/brand/icon-512.png -o docs/brand/icon-128.png resize 128 128
npx -y sharp-cli -i docs/brand/icon-512.png -o docs/brand/icon-32.png resize 32 32
```

### Social preview

`docs/banner/social_preview.svg` is the layout (background, grid, copy); the portrait is
composited on top at render time.

```bash
npx -y sharp-cli -i docs/brand/icon-512.png -o /tmp/portrait-360.png resize 360 360
npx -y sharp-cli -i docs/banner/social_preview.svg -o docs/banner/social_preview.png \
  composite /tmp/portrait-360.png --left 820 --top 140 --blend over
```

`docs/banner/social_preview.png` is what gets uploaded as the GitHub social preview
(Settings → General → Social preview); the repo file is the record of it.

### Final palette pass (do this last)

Every PNG in this repo is quantised to a 256-colour palette; it cuts the asset weight by
70–78% with no visible difference on this artwork, and keeps alpha (palette + `tRNS`).
Without this step a regenerated icon-512 is ~466 KB instead of ~122 KB.

```bash
npx -y sharp-cli ... # (generate as above)
# then, with `sharp` available to node:
#   await sharp(src).png({ palette: true, quality: 85, compressionLevel: 9, effort: 10 }).toFile(dst)
```

Check the result visually before committing — heavy gradients band in a 256-colour palette.
If `sharp-cli` is used for the resize step above, run the palette pass through a script: its
CLI does not expose `png({ palette })`.

## Rendering notes

- Text in SVG is rasterised through librsvg (via sharp). On this machine `Segoe UI`,
  `Microsoft YaHei UI` and `Consolas` all resolve; if a font is missing elsewhere the text
  falls back — check the output visually after regenerating.
- Keep the corner radius ratio at ~22% of the side length so the icon matches other
  rounded-square app icons.
- `docs/` is not shipped in the npm tarball, so these images are GitHub-only.
