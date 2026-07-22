import { BSON } from "../src/data/format.ts";

const mongodb = require("mongodb") as typeof import("mongodb");

function mulberry32(seed: number): () => number {
  return () => {
    seed |= 0;
    seed = seed + 0x6d2b79f5 | 0;
    let value = Math.imul(seed ^ seed >>> 15, 1 | seed);
    value = value + Math.imul(value ^ value >>> 7, 61 | value) ^ value;
    return ((value ^ value >>> 14) >>> 0) / 4_294_967_296;
  };
}

const random = mulberry32(0x4d464c49);
const integer = (min: number, max: number): number => Math.floor(random() * (max - min + 1)) + min;
const choose = <T>(values: readonly T[]): T => values[Math.floor(random() * values.length)]!;
const take = <T>(values: readonly T[], count: number): T[] => {
  const copy = [...values];
  for (let index = copy.length - 1; index > 0; index--) {
    const other = integer(0, index);
    [copy[index], copy[other]] = [copy[other]!, copy[index]!];
  }
  return copy.slice(0, count);
};
const deterministicId = (ordinal: number): InstanceType<typeof BSON.ObjectId> =>
  new BSON.ObjectId(ordinal.toString(16).padStart(24, "0"));

const uri = process.env.MONGOTUI_URI ?? "mongodb://localhost:27017";
const client = new mongodb.MongoClient(uri, { serverSelectionTimeoutMS: 5_000 });

try {
  await client.connect();
  const db = client.db("mflix");
  await db.dropDatabase();

  const countries = ["Argentina", "Canada", "France", "Germany", "India", "Japan", "Mexico", "Nigeria", "South Korea", "United Kingdom", "United States"] as const;
  const firstNames = ["Avery", "Cameron", "Dev", "Elena", "Fatima", "Hiro", "Jordan", "Leila", "Mateo", "Nora"] as const;
  const lastNames = ["Bennett", "Chen", "Diaz", "Ibrahim", "Kim", "Laurent", "Okafor", "Patel", "Sato", "Williams"] as const;
  const genres = ["Action", "Comedy", "Crime", "Documentary", "Drama", "Fantasy", "Horror", "Mystery", "Romance", "Sci-Fi", "Thriller"] as const;
  const adjectives = ["Broken", "Electric", "Hidden", "Last", "Lost", "Midnight", "Quiet", "Silver", "Unseen", "Wild"] as const;
  const nouns = ["City", "Dream", "Garden", "Journey", "Light", "River", "Signal", "Sky", "Story", "World"] as const;

  const directors = Array.from({ length: 50 }, (_, index) => ({
    _id: deterministicId(1_000 + index),
    name: `${firstNames[index % firstNames.length]} ${lastNames[Math.floor(index / firstNames.length) % lastNames.length]}`,
    born: integer(1935, 1990),
    country: choose(countries),
  }));
  await db.collection("directors").insertMany(directors);

  const movies = Array.from({ length: 500 }, (_, index) => {
    const rating = Number((1 + random() * 9).toFixed(1));
    const movie: Record<string, unknown> = {
      _id: deterministicId(10_000 + index),
      title: `${choose(adjectives)} ${choose(nouns)} ${index + 1}`,
      year: integer(1970, 2024),
      runtime: integer(72, 190),
      genres: take(genres, integer(1, 3)),
      imdb: { rating, votes: integer(50, 900_000), id: 1_000_000 + index },
      released: new Date(Date.UTC(integer(1970, 2024), integer(0, 11), integer(1, 28))),
      plot: `A ${choose(adjectives).toLowerCase()} tale of friendship, risk, and an unexpected ${choose(nouns).toLowerCase()}.`,
      cast: take([...firstNames, ...lastNames], integer(2, 5)),
      director_id: directors[integer(0, directors.length - 1)]!._id,
    };
    if (random() < 0.6) {
      movie.tomatoes = {
        viewer: { rating: Number((1 + random() * 4).toFixed(1)), numReviews: integer(5, 50_000) },
        critic: { rating: Number((1 + random() * 9).toFixed(1)), numReviews: integer(1, 500) },
        lastUpdated: new Date(Date.UTC(2025, integer(0, 11), integer(1, 28))),
      };
    }
    if (index < 3) delete movie.plot;
    if (index >= 3 && index < 7) movie.awards = { wins: integer(0, 8), nominations: integer(1, 20) };
    if (index === 7) movie.restored = true;
    return movie;
  });
  await db.collection("movies").insertMany(movies);

  const comments = Array.from({ length: 1_000 }, (_, index) => ({
    _id: deterministicId(20_000 + index),
    movie_id: movies[integer(0, movies.length - 1)]!._id,
    name: `${choose(firstNames)} ${choose(lastNames)}`,
    email: `viewer${index + 1}@example.com`,
    text: `Comment ${index + 1}: ${choose(["Loved it", "Worth watching", "Great cast", "Surprising ending", "Beautifully filmed"] as const)}.`,
    date: new Date(Date.UTC(integer(2010, 2025), integer(0, 11), integer(1, 28), integer(0, 23), integer(0, 59))),
  }));
  await db.collection("comments").insertMany(comments);

  const users = Array.from({ length: 100 }, (_, index) => ({
    _id: deterministicId(30_000 + index),
    name: `${choose(firstNames)} ${choose(lastNames)}`,
    email: `user${index + 1}@example.com`,
    prefs: {
      theme: choose(["dark", "light", "system"] as const),
      favoriteGenres: take(genres, integer(1, 3)),
      notifications: { email: random() < 0.7, weeklyDigest: random() < 0.45 },
    },
  }));
  await db.collection("users").insertMany(users);

  await db.collection("movies").createIndexes([
    { key: { year: 1 }, name: "year_1" },
    { key: { "imdb.rating": -1 }, name: "imdb.rating_-1" },
  ]);
  await db.collection("comments").createIndex({ movie_id: 1 }, { name: "movie_id_1" });

  for (const [name, count] of [["movies", movies.length], ["directors", directors.length], ["comments", comments.length], ["users", users.length]] as const) {
    console.log(`mflix.${name}: ${count} documents`);
  }
} catch (error) {
  throw new Error(`seed failed: ${error instanceof Error ? error.message : String(error)}`);
} finally {
  await client.close();
}

