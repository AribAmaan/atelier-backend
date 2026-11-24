import { PrismaClient } from "@prisma/client";
import bcrypt from "bcryptjs";
import crypto from "crypto";
import { characters as sfwCharacters } from "../sfw-premium-characters-with-assets";
import { animeCharacters } from "../anime-characters-with-assets";
import explicitCharacters from "./explicit-characters.json";

const prisma = new PrismaClient();

interface SeedCharacter {
  name: string;
  tagline: string;
  avatarEmoji: string;
  accentColor: string;
  personality: string;
  backstory: string;
  greeting: string;
  isExplicit: boolean;
  avatarUrl?: string;
  backgroundUrl?: string;
  avatarPrompt?: string;
  scenePromptTemplate?: string;
}

type CharacterVisuals = Pick<SeedCharacter, "avatarUrl" | "backgroundUrl">;

// Reuse the existing visual assets only when a character name matches, so a
// seed run updates the profile text while preserving its matching portrait
// and scene background.
const LEGACY_VISUALS_BY_NAME: Record<string, CharacterVisuals> = {
  "Elena Voss": { avatarUrl: "/assets/characters/elena-voss.png", backgroundUrl: "/assets/characters/backgrounds/elena-voss-bg.png" },
  "Marcus Reed": { avatarUrl: "/assets/characters/marcus-reed.png", backgroundUrl: "/assets/characters/backgrounds/marcus-reed-bg.png" },
  "Sophia Laurent": { avatarUrl: "/assets/characters/sophia-laurent.png", backgroundUrl: "/assets/characters/backgrounds/sophia-laurent-bg.png" },
  "Damien Black": { avatarUrl: "/assets/characters/damien-black.png", backgroundUrl: "/assets/characters/backgrounds/damien-black-bg.png" },
  "Lila Rose": { avatarUrl: "/assets/characters/lila-rose.png", backgroundUrl: "/assets/characters/backgrounds/lila-rose-bg.png" },
  "Scarlett Vale": { avatarUrl: "/assets/characters/scarlett-vale.png", backgroundUrl: "/assets/characters/backgrounds/scarlett-vale-bg.png" },
  "Victor Kane": { avatarUrl: "/assets/characters/victor-kane.png", backgroundUrl: "/assets/characters/backgrounds/victor-kane-bg.png" },
  "Nadia Voss": { avatarUrl: "/assets/characters/nadia-voss.png", backgroundUrl: "/assets/characters/backgrounds/nadia-voss-bg.png" },
  "Lilith Crowe": { avatarUrl: "/assets/characters/lilith-crowe.png", backgroundUrl: "/assets/characters/backgrounds/lilith-crowe-bg.png" },
  "Rhea Blackwood": { avatarUrl: "/assets/characters/rhea-blackwood.png", backgroundUrl: "/assets/characters/backgrounds/rhea-blackwood-bg.png" },
  "Isabella Voss": { avatarUrl: "/assets/characters/isabella-voss.png", backgroundUrl: "/assets/characters/backgrounds/isabella-voss-bg.png" },
  "Cassandra Noir": { avatarUrl: "/assets/characters/cassandra-noir.png", backgroundUrl: "/assets/characters/backgrounds/cassandra-noir-bg.png" },
  "Dr. Elena Hart": { avatarUrl: "/assets/characters/dr.-elena-hart.png", backgroundUrl: "/assets/characters/backgrounds/dr.-elena-hart-bg.png" },
  "Julian Cross": { avatarUrl: "/assets/characters/julian-cross.png", backgroundUrl: "/assets/characters/backgrounds/julian-cross-bg.png" },
  "Serena Vale": { avatarUrl: "/assets/characters/serena-vale.png", backgroundUrl: "/assets/characters/backgrounds/serena-vale-bg.png" },
  "Victoria Black": { avatarUrl: "/assets/characters/victoria-black.png", backgroundUrl: "/assets/characters/backgrounds/victoria-black-bg.png" },
  "Aria Sinclair": { avatarUrl: "/assets/characters/aria-sinclair.png", backgroundUrl: "/assets/characters/backgrounds/aria-sinclair-bg.png" },
  "Professor Lena Voss": { avatarUrl: "/assets/characters/professor-lena-voss.png", backgroundUrl: "/assets/characters/backgrounds/professor-lena-voss-bg.png" },
  "Morgana Crowe": { avatarUrl: "/assets/characters/morgana-crowe.png", backgroundUrl: "/assets/characters/backgrounds/morgana-crowe-bg.png" },
  "Diana Vale": { avatarUrl: "/assets/characters/diana-vale.png", backgroundUrl: "/assets/characters/backgrounds/diana-vale-bg.png" },
  "Raven Sinclair": { avatarUrl: "/assets/characters/raven-sinclair.png", backgroundUrl: "/assets/characters/backgrounds/raven-sinclair-bg.png" },
  "Dr. Amelia Cross": { avatarUrl: "/assets/characters/dr.-amelia-cross.png", backgroundUrl: "/assets/characters/backgrounds/dr.-amelia-cross-bg.png" },
  "Kira Vale": { avatarUrl: "/assets/characters/kira-vale.png", backgroundUrl: "/assets/characters/backgrounds/kira-vale-bg.png" },
  "Selene Blackthorn": { avatarUrl: "/assets/characters/selene-blackthorn.png", backgroundUrl: "/assets/characters/backgrounds/selene-blackthorn-bg.png" },
  "Luna Voss": { avatarUrl: "/assets/characters/luna-voss.png", backgroundUrl: "/assets/characters/backgrounds/luna-voss-bg.png" },
  "Ophelia Noir": { avatarUrl: "/assets/characters/ophelia-noir.png", backgroundUrl: "/assets/characters/backgrounds/ophelia-noir-bg.png" },
  "Freya Storm": { avatarUrl: "/assets/characters/freya-storm.png", backgroundUrl: "/assets/characters/backgrounds/freya-storm-bg.png" },
  "Evelyn Rose": { avatarUrl: "/assets/characters/evelyn-rose.png", backgroundUrl: "/assets/characters/backgrounds/evelyn-rose-bg.png" },
  "Nyra Shadow": { avatarUrl: "/assets/characters/nyra-shadow.png", backgroundUrl: "/assets/characters/backgrounds/nyra-shadow-bg.png" },
  "Vesper Hale": { avatarUrl: "/assets/characters/vesper-hale.png", backgroundUrl: "/assets/characters/backgrounds/vesper-hale-bg.png" },
};

async function main() {
  const sfwSeedCharacters: SeedCharacter[] = sfwCharacters.map((c) => ({
    name: c.name,
    tagline: c.tagline,
    avatarEmoji: c.avatarEmoji,
    accentColor: c.accentColor,
    personality: c.personality,
    backstory: c.backstory,
    greeting: c.greeting,
    // This dataset is definitionally the SFW set, so keep the seed flag
    // authoritative even if imported asset metadata is ever regenerated.
    isExplicit: false,
    avatarUrl: c.avatarUrl,
    backgroundUrl: c.backgroundUrl,
  }));

  const animeSeedCharacters: SeedCharacter[] = animeCharacters.map((c) => ({
    name: c.name,
    tagline: c.tagline,
    avatarEmoji: c.avatarEmoji,
    accentColor: c.accentColor,
    personality: c.personality,
    backstory: c.backstory,
    greeting: c.greeting,
    isExplicit: c.isExplicit,
    avatarUrl: c.avatarUrl,
    backgroundUrl: c.backgroundUrl,
    avatarPrompt: c.avatarPrompt,
    scenePromptTemplate: c.scenePromptTemplate,
  }));

  // Explicit characters are seeded as 18+.
  const explicitSeedCharacters: SeedCharacter[] = explicitCharacters.map((c) => ({
    ...c,
    isExplicit: true,
  }));


  const allCharacters: SeedCharacter[] = [
    ...sfwSeedCharacters,
    ...animeSeedCharacters,
    ...explicitSeedCharacters,
  ];

  console.log(
    `Loaded ${allCharacters.length} characters total (${sfwSeedCharacters.length} premium + ${animeSeedCharacters.length} anime + ${explicitSeedCharacters.length} explicit)`
  );

  let seedUser = await prisma.user.findUnique({
    where: { email: "seed@rolichat.local" },
  });

  if (!seedUser) {
    seedUser = await prisma.user.create({
      data: {
        email: "seed@rolichat.local",
        passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10),
        displayName: "Rolichat Seed",
        birthdate: new Date("1990-01-01"),
        tosAcceptedAt: new Date(),
        emailVerified: true,
      },
    });
    console.log(`Created seed user: ${seedUser.id}`);
  } else {
    // This account only owns the seeded characters and must never be a usable
    // login. Rotate to a random, never-revealed secret on every run so older
    // deployments that were created with a known password get fixed too.
    await prisma.user.update({
      where: { id: seedUser.id },
      data: { passwordHash: await bcrypt.hash(crypto.randomBytes(32).toString("hex"), 10) },
    });
  }

  const existingCount = await prisma.character.count({
    where: { ownerId: seedUser.id },
  });
  console.log(`Existing characters for seed user: ${existingCount}`);

  // Upsert each seed character by (ownerId, name) instead of skipping once the
  // count matches. The old count-based guard meant that once a bad seed run
  // landed (e.g. a data bug flipping isExplicit), re-running the seed script
  // would never fix it - it only ever flipped isPublic and returned early.
  // This version always corrects every field on every run, and only creates
  // rows that don't already exist.
  let created = 0;
  let updated = 0;

  for (const char of allCharacters) {
    const existing = await prisma.character.findFirst({
      where: { ownerId: seedUser.id, name: char.name },
      select: { id: true },
    });

    const legacyVisuals = LEGACY_VISUALS_BY_NAME[char.name];
    const data: any = {
      tagline: char.tagline,
      avatarEmoji: char.avatarEmoji || "🌸",
      accentColor: char.accentColor || "#c9a227",
      personality: char.personality,
      backstory: char.backstory,
      greeting: char.greeting,
      isExplicit: char.isExplicit,
      avatarUrl: char.avatarUrl ?? legacyVisuals?.avatarUrl ?? null,
      backgroundUrl: char.backgroundUrl ?? legacyVisuals?.backgroundUrl ?? null,
      isPublic: true,
    };
    if (char.avatarPrompt) data.avatarPrompt = char.avatarPrompt;
    if (char.scenePromptTemplate) data.scenePromptTemplate = char.scenePromptTemplate;

    if (existing) {
      await prisma.character.update({ where: { id: existing.id }, data });
      updated++;
    } else {
      await prisma.character.create({ data: { ownerId: seedUser.id, name: char.name, ...data } });
      created++;
    }
  }

  // Clean up seed-owned characters no longer present in the source data
  // (e.g. renamed or removed from the JSON/TS files).
  const currentNames = allCharacters.map((c) => c.name);
  const removed = await prisma.character.deleteMany({
    where: { ownerId: seedUser.id, name: { notIn: currentNames } },
  });

  console.log(
    `Seed complete: ${created} created, ${updated} updated, ${removed.count} removed. ${allCharacters.length} total.`
  );
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
