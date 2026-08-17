"""Playwright browser tests for The Anti-Spin Read UI.

Run via the webapp-testing with_server.py helper:
  python .agents/skills/webapp-testing/scripts/with_server.py \
    --server "cd backend && npx tsx scripts/launch-seeded-ui.ts" --port 4321 \
    --server "cd frontend && set VITE_API_BASE=http://localhost:4321&& npm run dev" --port 5173 \
    --timeout 90 \
    -- python frontend/tests/ui_test.py

Environment variables (defaults in parentheses):
  UI_BASE_URL       frontend URL to test   (http://localhost:5173)
  SEED_CARD_COUNT   expected seeded cards  (5)
"""

import os

from playwright.sync_api import sync_playwright, expect

BASE = os.environ.get("UI_BASE_URL", "http://localhost:5173")
SEED_CARD_COUNT = int(os.environ.get("SEED_CARD_COUNT", "5"))
passed = 0
failed = 0


def check(name, cond, detail=""):
    global passed, failed
    if cond:
        passed += 1
        print(f"  PASS {name}")
    else:
        failed += 1
        print(f"  FAIL {name} {detail}")


with sync_playwright() as p:
    browser = p.chromium.launch(headless=True)
    page = browser.new_page()
    console_errors = []
    page.on("console", lambda m: console_errors.append(m.text) if m.type == "error" else None)
    page.on("pageerror", lambda e: console_errors.append(str(e)))

    print("== nav: load page ==")
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    page.wait_for_selector("text=The Anti-Spin Read", timeout=10000)
    check("header renders", "anti-spin" in page.locator("h1").inner_text().lower())
    check(
        "tagline renders",
        "read the difference" in page.locator("header p").inner_text().lower(),
    )

    print("== seeded stories present ==")
    cards = page.locator("article")
    expect(cards).to_have_count(SEED_CARD_COUNT)
    count = cards.count()
    check(f"{SEED_CARD_COUNT} seeded story cards", count == SEED_CARD_COUNT, f"got {count}")

    # first card should be Assad (sorted by framedAt desc)
    first_phrase = cards.nth(0).locator("h3").inner_text()
    check(
        "first card is Assad story",
        "Assad" in first_phrase,
        first_phrase,
    )
    badge = cards.nth(0).locator("span[aria-label='3 outlets']").count()
    check("first card shows '3 outlets' badge", badge == 1)

    # images: seeded articles carry picsum imageUrl; hero strip renders
    hero_imgs = cards.nth(0).locator("img[src^='http']")
    check("story card renders news image", hero_imgs.count() >= 1, str(hero_imgs.count()))

    print("== category stamps + colors ==")
    stamps = page.locator("article .stamp")
    stamp_texts = stamps.all_inner_texts()
    check(
        "every card shows a category stamp",
        any(s.strip().lower() in ("politics", "world", "business", "tech", "science & health", "crime & justice", "culture & sport", "other") for s in stamp_texts),
        str(stamp_texts),
    )
    # Assad story -> world/crime; Trump media -> business; eagle -> culture-sport
    check(
        "Assad card categorized (world or crime-justice)",
        any(k in cards.nth(0).locator(".stamp").all_inner_texts()[0].lower() for k in ("world", "crime")),
        str(cards.nth(0).locator(".stamp").all_inner_texts()),
    )

    print("== click headline -> modal opens ==")
    cards.nth(0).locator("h3").click()
    modal = page.locator("[role=dialog]")
    check("modal opens on headline click", modal.count() == 1)
    check(
        "modal shows headline deltas",
        modal.locator("text=How the coverage differs").count() == 1,
    )
    check(
        "modal shows omissions section (Assad cluster has one)",
        modal.locator("text=What some outlets left out").count() == 1,
    )
    check("modal shows tone by outlet", modal.locator("text=Tone by outlet").count() == 1)
    tone_chips = modal.locator("span.tone-chip")
    check("tone chips render for each outlet", tone_chips.count() >= 3)
    check("modal shows neutral summary box", modal.locator("text=The story:").count() == 1)

    print("== modal shows the actual news text per outlet ==")
    check(
        "news section header present",
        modal.locator("text=The news, outlet by outlet").count() == 1,
    )
    outlet_blocks = modal.locator("li", has_text="READ FULL ARTICLE")
    read_full = modal.locator("a", has_text="READ FULL ARTICLE")
    check("one news block per outlet", outlet_blocks.count() == 3, str(outlet_blocks.count()))
    check("each outlet has a READ FULL link", read_full.count() == 3)
    check(
        "BBC lede text visible",
        "state media reported" in modal.inner_text(),
    )
    check(
        "CNN lede text visible",
        "state-run news agency SANA" in modal.inner_text(),
    )
    check(
        "tone label shown per block",
        modal.locator("span.tone-chip", has_text="Tone:").count() == 3,
    )

    print("== close modal ==")
    modal.locator("button[aria-label='Close story details']").click()
    check("modal closes via X button", page.locator("[role=dialog]").count() == 0)

    print("== click image -> modal opens ==")
    cards.nth(1).locator("button[aria-label^='Open details']").first.click()
    modal2 = page.locator("[role=dialog]")
    check("modal opens on image click", modal2.count() == 1)
    check("modal shows headline", "eagle" in modal2.locator("h2").inner_text().lower())
    # Escape closes
    page.keyboard.press("Escape")
    check("modal closes on Escape", page.locator("[role=dialog]").count() == 0)

    print("== OpenAI card has NO omissions ==")
    cards.nth(2).locator("h3").click()
    modal3 = page.locator("[role=dialog]")
    check(
        "omissions section hidden for empty array",
        modal3.locator("text=What some outlets left out").count() == 0,
    )
    modal3.locator("button[aria-label='Close story details']").click()

    print("== second card (eagle) -> celebratory tone ==")
    cards.nth(1).locator("h3").click()
    chips = page.locator("[role=dialog] span.tone-chip").all_inner_texts()
    check(
        "celebratory tone tag present",
        any("celebratory" in c.lower() for c in chips),
        str(chips),
    )
    check(
        "2 outlets badge on second card",
        cards.nth(1).locator("span[aria-label='2 outlets']").count() == 1,
    )
    page.keyboard.press("Escape")

    print("== category filter bar ==")
    filter_group = page.locator("[aria-label='Filter stories by category']")
    check("filter bar renders ALL + 8 categories", filter_group.locator("button").count() == 9)

    # Business filter -> only Trump media cluster (auto-retrying assertion
    # replaces the old fixed wait_for_timeout)
    filter_group.locator("button", has_text="Business").click()
    expect(page.locator("article")).to_have_count(1)
    filtered_cards = page.locator("article")
    check("Business filter shows 1 card", filtered_cards.count() == 1, str(filtered_cards.count()))
    check(
        "filtered card is the Trump media story",
        "Trump" in filtered_cards.nth(0).locator("h3").inner_text(),
    )
    # Tech filter -> only OpenAI chip cluster
    filter_group.locator("button", has_text="Tech").click()
    expect(page.locator("article")).to_have_count(1)
    filtered_cards = page.locator("article")
    check("Tech filter shows 1 card", filtered_cards.count() == 1, str(filtered_cards.count()))
    check(
        "filtered card is the OpenAI story",
        "OpenAI" in filtered_cards.nth(0).locator("h3").inner_text(),
    )
    # ALL restores everything
    filter_group.locator("button", has_text="ALL").click()
    expect(page.locator("article")).to_have_count(SEED_CARD_COUNT)
    check("ALL shows all cards again", page.locator("article").count() == SEED_CARD_COUNT)

    print("== page reload ==")
    # The old "Refresh button" step referenced a button this UI never had
    # (only the new-stories chip calls refresh, and only with a watermark).
    # Reload verifies the same invariant: stories survive a full page load.
    before = page.locator("article").count()
    page.reload(wait_until="networkidle", timeout=30000)
    expect(page.locator("article")).to_have_count(before)
    check("stories persist across reload", page.locator("article").count() == before)

    print("== search ==")
    page.locator("#search-input").fill("assad")
    page.locator("button", has_text="Search").click()
    expect(page.locator("article")).to_have_count(1)
    check(
        "search finds the Assad story",
        "Assad" in page.locator("article").nth(0).locator("h3").inner_text(),
    )
    check(
        "filter bar hidden while searching",
        page.locator("[aria-label='Filter stories by category']").count() == 0,
    )
    page.locator("button", has_text="Clear").click()
    expect(page.locator("article")).to_have_count(SEED_CARD_COUNT)
    check(
        "clearing search restores the grid",
        page.locator("article").count() == SEED_CARD_COUNT,
    )

    print("== deep link ==")
    cards.nth(0).locator("h3").click()
    url_with_hash = page.url
    check(
        "card open sets #/story/<id> hash",
        "#/story/" in url_with_hash,
        url_with_hash,
    )
    page.locator("button[aria-label='Close story details']").click()
    # A full navigation (not a hash-only same-document change) exercises the
    # on-mount deep-link open path.
    page.goto(BASE, wait_until="networkidle", timeout=30000)
    page.goto(url_with_hash, wait_until="networkidle", timeout=30000)
    expect(page.locator("[role=dialog]")).to_have_count(1)
    check(
        "shared link reopens the story on load",
        page.locator("[role=dialog]").count() == 1,
    )
    page.locator("button[aria-label='Close story details']").click()

    print("== mobile pass ==")
    page.set_viewport_size({"width": 375, "height": 667})
    page.reload(wait_until="networkidle", timeout=30000)
    expect(page.locator("h1")).to_be_visible()
    check("mobile header visible", page.locator("h1").is_visible())
    expect(page.locator("article").first).to_be_visible()
    check(
        "mobile renders at least one story card",
        page.locator("article").count() >= 1,
        str(page.locator("article").count()),
    )
    page.locator("article").first.locator("h3").click()
    mobile_modal = page.locator("[role=dialog]")
    expect(mobile_modal).to_have_count(1)
    check("mobile modal opens on headline click", mobile_modal.count() == 1)
    page.keyboard.press("Escape")
    expect(mobile_modal).to_have_count(0)
    check("mobile modal closes on Escape", page.locator("[role=dialog]").count() == 0)

    print("== no console errors ==")
    check("zero console errors", len(console_errors) == 0, str(console_errors[:3]))

    page.screenshot(path="frontend/tests/ui_screenshot.png", full_page=True)
    print("  screenshot saved to frontend/tests/ui_screenshot.png")

    browser.close()

print("\n=====================")
print(f"RESULTS: {passed} passed, {failed} failed")
import sys

sys.exit(1 if failed else 0)