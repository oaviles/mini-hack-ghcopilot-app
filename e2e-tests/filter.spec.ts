import { test, expect } from '@playwright/test';

test.describe('Game Filtering', () => {
  test.beforeEach(async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('games-grid')).toBeVisible();
  });

  test('should display the filter bar with category and publisher groups', async ({ page }) => {
    await test.step('Verify filter bar is visible', async () => {
      await expect(page.getByTestId('filter-bar')).toBeVisible();
    });

    await test.step('Verify category filter group has an "All" button', async () => {
      await expect(page.getByTestId('category-filter-all')).toBeVisible();
      await expect(page.getByTestId('category-filter-all')).toContainText('All');
    });

    await test.step('Verify publisher filter group has an "All" button', async () => {
      await expect(page.getByTestId('publisher-filter-all')).toBeVisible();
      await expect(page.getByTestId('publisher-filter-all')).toContainText('All');
    });

    await test.step('"All" buttons are initially pressed', async () => {
      await expect(page.getByTestId('category-filter-all')).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('publisher-filter-all')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test('should filter games by category and mark the active pill', async ({ page }) => {
    let totalGames: number;

    await test.step('Record the total game count', async () => {
      totalGames = await page.getByTestId('game-card').count();
      expect(totalGames).toBeGreaterThan(0);
    });

    await test.step('Click the first specific category pill', async () => {
      const firstCatPill = page
        .getByTestId('category-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first();
      await firstCatPill.click();

      // The clicked pill should become active and "All" should be deactivated.
      await expect(firstCatPill).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('category-filter-all')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('Visible game count is a non-zero subset of all games', async () => {
      // Cards hidden by JS filtering have an inline style="display: none;".
      // This selector counts only cards without that inline override.
      const visibleCards = page.locator('[data-testid="game-card"]:not([style*="display"])');
      const visibleCount = await visibleCards.count();
      expect(visibleCount).toBeGreaterThan(0);
      expect(visibleCount).toBeLessThanOrEqual(totalGames);
    });
  });

  test('should filter games by publisher and mark the active pill', async ({ page }) => {
    let totalGames: number;

    await test.step('Record the total game count', async () => {
      totalGames = await page.getByTestId('game-card').count();
    });

    await test.step('Click the first specific publisher pill', async () => {
      const firstPubPill = page
        .getByTestId('publisher-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first();
      await firstPubPill.click();

      await expect(firstPubPill).toHaveAttribute('aria-pressed', 'true');
      await expect(page.getByTestId('publisher-filter-all')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('Visible game count is a non-zero subset of all games', async () => {
      const visibleCards = page.locator('[data-testid="game-card"]:not([style*="display"])');
      const visibleCount = await visibleCards.count();
      expect(visibleCount).toBeGreaterThan(0);
      expect(visibleCount).toBeLessThanOrEqual(totalGames);
    });
  });

  test('"All" button resets the category filter and restores all games', async ({ page }) => {
    let totalGames: number;

    await test.step('Record the total game count', async () => {
      totalGames = await page.getByTestId('game-card').count();
    });

    await test.step('Apply a category filter', async () => {
      await page
        .getByTestId('category-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first()
        .click();
    });

    await test.step('Click "All" to reset the category filter', async () => {
      await page.getByTestId('category-filter-all').click();
    });

    await test.step('All games are visible again', async () => {
      const visibleCards = page.locator('[data-testid="game-card"]:not([style*="display"])');
      await expect(visibleCards).toHaveCount(totalGames);
      await expect(page.getByTestId('category-filter-all')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test('"All" button resets the publisher filter and restores all games', async ({ page }) => {
    let totalGames: number;

    await test.step('Record the total game count', async () => {
      totalGames = await page.getByTestId('game-card').count();
    });

    await test.step('Apply a publisher filter', async () => {
      await page
        .getByTestId('publisher-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first()
        .click();
    });

    await test.step('Click "All" to reset the publisher filter', async () => {
      await page.getByTestId('publisher-filter-all').click();
    });

    await test.step('All games are visible again', async () => {
      const visibleCards = page.locator('[data-testid="game-card"]:not([style*="display"])');
      await expect(visibleCards).toHaveCount(totalGames);
      await expect(page.getByTestId('publisher-filter-all')).toHaveAttribute('aria-pressed', 'true');
    });
  });

  test('both category and publisher filters apply simultaneously with AND logic', async ({ page }) => {
    await test.step('Select the first category filter', async () => {
      await page
        .getByTestId('category-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first()
        .click();
    });

    let categoryOnlyCount: number;
    await test.step('Record the count after category filter', async () => {
      categoryOnlyCount = await page
        .locator('[data-testid="game-card"]:not([style*="display"])')
        .count();
      expect(categoryOnlyCount).toBeGreaterThan(0);
    });

    await test.step('Also select the first publisher filter', async () => {
      await page
        .getByTestId('publisher-filter-group')
        .getByRole('button')
        .filter({ hasNotText: 'All' })
        .first()
        .click();
    });

    await test.step('Both pills are active simultaneously', async () => {
      await expect(page.getByTestId('category-filter-all')).toHaveAttribute('aria-pressed', 'false');
      await expect(page.getByTestId('publisher-filter-all')).toHaveAttribute('aria-pressed', 'false');
    });

    await test.step('AND filter yields no more than the category-only count', async () => {
      const andCount = await page
        .locator('[data-testid="game-card"]:not([style*="display"])')
        .count();
      expect(andCount).toBeLessThanOrEqual(categoryOnlyCount);
    });
  });
});
