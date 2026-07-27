import { describe, it, expect, beforeEach } from 'vitest';
import { createTestDatabase } from '../../db/test-helpers';
import { categories, publishers, games } from '../../db/schema';
import type { Database } from './db';
import {
    getAllGames,
    getAllGameIds,
    getGameById,
    getAllCategories,
    getAllPublishers,
} from './games';

async function seedGames(db: Database, count: number): Promise<void> {
    const [category] = await db
        .insert(categories)
        .values({ name: 'Strategy', description: 'cat' })
        .returning({ id: categories.id });
    const [publisher] = await db
        .insert(publishers)
        .values({ name: 'Pub One', description: 'pub' })
        .returning({ id: publishers.id });

    // Insert titles in reverse-alphabetical order to prove ordering is applied.
    for (let i = count; i >= 1; i--) {
        await db.insert(games).values({
            title: `Game ${String(i).padStart(2, '0')}`,
            description: `Description ${i}`,
            starRating: 4.2,
            categoryId: category.id,
            publisherId: publisher.id,
        });
    }
}

describe('games data-access helpers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns all games ordered by title', async () => {
        await seedGames(db, 3);
        const all = await getAllGames(db);
        expect(all.map((g) => g.title)).toEqual(['Game 01', 'Game 02', 'Game 03']);
        expect(all[0].category).toEqual({ id: expect.any(Number), name: 'Strategy' });
        expect(all[0].publisher).toEqual({ id: expect.any(Number), name: 'Pub One' });
    });

    it('returns all game ids ordered by title', async () => {
        await seedGames(db, 3);
        const ids = await getAllGameIds(db);
        const all = await getAllGames(db);
        expect(ids).toEqual(all.map((g) => g.id));
    });

    it('fetches a single game by id', async () => {
        await seedGames(db, 2);
        const ids = await getAllGameIds(db);
        const game = await getGameById(db, ids[0]);
        expect(game?.title).toBe('Game 01');
    });

    it('returns null for a non-existent game', async () => {
        await seedGames(db, 2);
        expect(await getGameById(db, 99999)).toBeNull();
    });
});

describe('getAllCategories', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns an empty list when no categories exist', async () => {
        const result = await getAllCategories(db);
        expect(result).toEqual([]);
    });

    it('returns categories ordered by name', async () => {
        await db.insert(categories).values([
            { name: 'Strategy', description: 'strat' },
            { name: 'Puzzle', description: 'puzz' },
            { name: 'Arcade', description: 'arc' },
        ]);
        const result = await getAllCategories(db);
        expect(result.map((c) => c.name)).toEqual(['Arcade', 'Puzzle', 'Strategy']);
    });

    it('returns objects with id and name fields', async () => {
        await db.insert(categories).values({ name: 'Simulation', description: 'sim' });
        const result = await getAllCategories(db);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: expect.any(Number), name: 'Simulation' });
    });
});

describe('getAllPublishers', () => {
    let db: Database;

    beforeEach(async () => {
        db = await createTestDatabase();
    });

    it('returns an empty list when no publishers exist', async () => {
        const result = await getAllPublishers(db);
        expect(result).toEqual([]);
    });

    it('returns publishers ordered by name', async () => {
        await db.insert(publishers).values([
            { name: 'Zephyr Studios', description: 'z' },
            { name: 'Alpha Games', description: 'a' },
            { name: 'MidTier Inc.', description: 'm' },
        ]);
        const result = await getAllPublishers(db);
        expect(result.map((p) => p.name)).toEqual(['Alpha Games', 'MidTier Inc.', 'Zephyr Studios']);
    });

    it('returns objects with id and name fields', async () => {
        await db.insert(publishers).values({ name: 'CodeForge Studios', description: 'cf' });
        const result = await getAllPublishers(db);
        expect(result).toHaveLength(1);
        expect(result[0]).toMatchObject({ id: expect.any(Number), name: 'CodeForge Studios' });
    });
});
