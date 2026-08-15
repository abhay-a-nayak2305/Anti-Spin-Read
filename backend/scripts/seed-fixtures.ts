import { hashText } from "../src/scraper.js";
import { MemoryDb } from "../src/db-memory.js";
import type { RawArticle } from "../src/types.js";

/**
 * Realistic seed data (articles + clusters + framings) for the seeded UI
 * server and API tests. Deterministic, offline, no network needed.
 */
export async function seedFixtures(db: MemoryDb): Promise<void> {
  const now = Date.now();
  const mk = (source: string, title: string, hoursAgo: number, lede: string): RawArticle => ({
    dedupKey: `seed|${source}|${title}`,
    source,
    title,
    url: `https://${source.toLowerCase()}.example/${title.replace(/\s+/g, "-")}`,
    lede,
    publishedAt: new Date(now - hoursAgo * 3600_000),
    // Deterministic placeholder images for UI dev (no network needed to serve)
    imageUrl: `https://picsum.photos/seed/${source.toLowerCase()}/640/400`,
  });

  const a1 = mk("BBC", "Ousted Syrian dictator Bashar al-Assad sentenced to death in absentia", 2,
    "A court in Damascus has sentenced ousted president Bashar al-Assad to death in absentia, state media reported, in a case spanning killings and torture committed during Syria's civil war.");
  const a2 = mk("CNN", "Former Syrian President Assad sentenced to death in absentia", 2,
    "Former Syrian President Bashar al-Assad was sentenced to death in absentia by a Syrian court on Sunday, according to the state-run news agency SANA.");
  const a3 = mk("NPR", "Syrian court sentences Bashar al-Assad to death in absentia", 1,
    "A Syrian court has sentenced the country's former leader to death in absentia over crimes committed during the conflict, drawing mixed reactions from legal experts.");
  const a4 = mk("Reuters", "Trump media company announces a massive loss", 5,
    "Trump Media & Technology Group, the company behind Truth Social, reported a loss of $238 million for the latest quarter, sending its shares down sharply in after-hours trading.");
  const a5 = mk("Guardian", "Trump's media company reports $238m loss", 5,
    "The parent company of Truth Social has reported a $238m loss, raising fresh questions about the finances of the media venture controlled by Donald Trump.");
  const a6 = mk("AP", "Jackie, the California bald eagle who became an internet sensation, dies after illness", 3,
    "Jackie, the California bald eagle whose live nest camera made her an internet celebrity, has died after a brief illness, wildlife officials said.");
  const a7 = mk("BBC", "Jackie, the famous California bald eagle, dies after weeks of intensive care", 3,
    "The famous California bald eagle Jackie, watched by millions on a live stream, has died after weeks of intensive care at a wildlife sanctuary.");
  const a8 = mk("Reuters", "OpenAI unveils new AI chip to rival Nvidia in data centers", 4,
    "OpenAI said it has designed its own AI chip, built with Broadcom, to cut the cost of running its models in data centers and reduce reliance on Nvidia.");
  const a9 = mk("Guardian", "OpenAI's new custom chip challenges Nvidia's data center dominance", 4,
    "OpenAI's new custom silicon, unveiled on Tuesday, is aimed at loosening Nvidia's grip on the market for the chips that power artificial intelligence.");
  const a10 = mk("AP", "World Cup final breaks viewing records as champions crowned", 6,
    "The World Cup final attracted a record global audience, with broadcasters reporting hundreds of millions of viewers watched the title match.");
  const a11 = mk("BBC", "World Cup final draws record global audience in historic title match", 6,
    "A historic World Cup final drew the largest television audience in the tournament's history as the champions were crowned after a tense extra-time finish.");

  await db.insertArticles([a1, a2, a3, a4, a5, a6, a7, a8, a9, a10, a11]);

  const sig = (keys: string[]) => hashText([...keys].sort().join("|"));

  const c1 = await db.createCluster(
    "Bashar al-Assad sentenced to death",
    [a1.dedupKey, a2.dedupKey, a3.dedupKey],
    new Date(now - 2 * 3600_000),
    sig([a1.dedupKey, a2.dedupKey, a3.dedupKey])
  );
  await db.saveFraming(
    c1,
    {
      headlineDeltas: [
        "BBC labels Assad an 'ousted Syrian dictator' — leading with regime collapse framing.",
        "CNN and NPR describe him as 'former Syrian President', emphasizing institutional language.",
      ],
      toneTags: [
        { source: "BBC", tone: "neutral" },
        { source: "CNN", tone: "analytical" },
        { source: "NPR", tone: "neutral" },
      ],
      notableOmissions: ["NPR omits the 'dictator' characterization present in BBC's headline."],
      neutralSummary:
        "A Syrian court sentenced Bashar al-Assad to death in absentia over killings and torture committed during his rule.",
    },
    new Date(now - 1 * 3600_000),
    null
  );

  const c2 = await db.createCluster(
    "Trump media stock plunges after massive loss",
    [a4.dedupKey, a5.dedupKey],
    new Date(now - 5 * 3600_000),
    sig([a4.dedupKey, a5.dedupKey])
  );
  await db.saveFraming(
    c2,
    {
      headlineDeltas: [
        "Reuters leads with the scale of the loss; The Guardian adds the Truth Social ownership detail.",
      ],
      toneTags: [
        { source: "Reuters", tone: "neutral" },
        { source: "Guardian", tone: "analytical" },
      ],
      notableOmissions: [],
      neutralSummary: "Trump's media company reported a $238m loss and announced a new turnaround effort.",
    },
    new Date(now - 4 * 3600_000),
    null
  );

  const c3 = await db.createCluster(
    "California bald eagle Jackie dies",
    [a6.dedupKey, a7.dedupKey],
    new Date(now - 3 * 3600_000),
    sig([a6.dedupKey, a7.dedupKey])
  );
  await db.saveFraming(
    c3,
    {
      headlineDeltas: [
        "AP centers the eagle's internet-famous status; BBC leads with the months of care before death.",
      ],
      toneTags: [
        { source: "AP", tone: "neutral" },
        { source: "BBC", tone: "celebratory" },
      ],
      notableOmissions: [],
      neutralSummary: "Jackie, a celebrity California bald eagle, died after a period of intensive care.",
    },
    new Date(now - 2 * 3600_000),
    null
  );

  const c4 = await db.createCluster(
    "OpenAI unveils new AI chip for data centers",
    [a8.dedupKey, a9.dedupKey],
    new Date(now - 4 * 3600_000),
    sig([a8.dedupKey, a9.dedupKey])
  );
  await db.saveFraming(
    c4,
    {
      headlineDeltas: [
        "Reuters frames it as a chip announcement; The Guardian highlights the challenge to Nvidia's dominance.",
      ],
      toneTags: [
        { source: "Reuters", tone: "neutral" },
        { source: "Guardian", tone: "analytical" },
      ],
      notableOmissions: [],
      neutralSummary: "OpenAI announced a custom AI chip designed to reduce reliance on Nvidia in data centers.",
    },
    new Date(now - 3 * 3600_000),
    null
  );

  const c5 = await db.createCluster(
    "World Cup final breaks viewing records",
    [a10.dedupKey, a11.dedupKey],
    new Date(now - 6 * 3600_000),
    sig([a10.dedupKey, a11.dedupKey])
  );
  await db.saveFraming(
    c5,
    {
      headlineDeltas: [
        "AP leads with the record-breaking audience; BBC centers the champions' historic title match.",
      ],
      toneTags: [
        { source: "AP", tone: "celebratory" },
        { source: "BBC", tone: "celebratory" },
      ],
      notableOmissions: [],
      neutralSummary: "The World Cup final attracted a record global television audience as a new champion was crowned.",
    },
    new Date(now - 5 * 3600_000),
    null
  );

  console.log(`[seed] ${db.articles.size} articles, ${db.clusters.length} clusters + framings created`);
}