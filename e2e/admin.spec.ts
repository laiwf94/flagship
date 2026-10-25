import AxeBuilder from '@axe-core/playwright';
import { expect, test, type Browser, type Page } from '@playwright/test';
import { ADMIN, EDITOR } from './seed';

const base = () => {
  const b = process.env.E2E_BASE_URL;
  if (b === undefined) throw new Error('E2E_BASE_URL not set; run through playwright.config.ts');
  return b;
};
const P = '/p/default/production';

async function signIn(page: Page, who = EDITOR): Promise<void> {
  await page.goto(`${base()}/sign-in`);
  await page.getByLabel('Email').fill(who.email);
  await page.getByLabel('Password').fill(who.password);
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('heading', { name: 'Flags' })).toBeVisible();
}

async function newSignedInPage(browser: Browser, who = EDITOR): Promise<Page> {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  await signIn(page, who);
  return page;
}

/** No serious or critical WCAG 2.1 A/AA violations. */
async function expectAccessible(page: Page, what: string): Promise<void> {
  const result = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  const bad = result.violations.filter((v) => v.impact === 'serious' || v.impact === 'critical');
  expect(
    bad.map((v) => `${v.id}: ${v.help} (${v.nodes.map((n) => n.target.join(' ')).join(', ')})`),
    `${what} has accessibility violations`,
  ).toEqual([]);
}

async function expectNoHorizontalScroll(page: Page, what: string): Promise<void> {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow, `${what} scrolls sideways`).toBeLessThanOrEqual(0);
}

test.describe.configure({ mode: 'serial' });

test('sign in, create a flag, add a rule, roll out, review the diff and save', async ({ page }) => {
  await signIn(page);
  await page.getByRole('button', { name: 'Create flag' }).click();
  const dialog = page.getByRole('dialog', { name: 'Create flag' });
  await dialog.getByLabel('Name').fill('Onboarding checklist');
  await expect(dialog.getByLabel('Key')).toHaveValue('onboarding-checklist');
  await dialog.getByRole('button', { name: 'Create flag' }).click();
  await expect(page.getByRole('heading', { name: 'Onboarding checklist' })).toBeVisible();
  await expect(page.getByText('Off', { exact: true })).toBeVisible();
  await expect(page.getByText(/None of 10,000 sample users/)).toBeVisible();

  await page.getByRole('switch', { name: 'Off in Production' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn on' }).click();
  await expect(page.getByRole('switch', { name: 'On in Production' })).toBeVisible();

  await page.getByRole('button', { name: 'Add rule' }).click();
  const condition = page.getByRole('group', { name: 'Condition 1' });
  await condition.getByLabel('Values').fill('@acme.com');
  await page.getByLabel('Rule 1 serves', { exact: true }).selectOption('on');

  const defaultRule = page.locator('section', {
    has: page.getByRole('heading', { name: 'Default rule' }),
  });
  await defaultRule.getByRole('radio', { name: 'Percentage rollout' }).click();
  await defaultRule.getByRole('slider').fill('20');
  await expect(defaultRule.getByText('Turned on for 20% of users')).toBeVisible();
  await expect(page.getByText(/would change variant if you save/)).toBeVisible();

  await page.getByRole('button', { name: 'Review and save' }).click();
  const review = page.getByRole('dialog', { name: /Review changes/ });
  await expect(review.getByText('Rule 1', { exact: true })).toBeVisible();
  await expect(review.getByText('Default rule › rollout')).toBeVisible();
  await expectAccessible(page, 'review dialog');
  await review.getByRole('button', { name: 'Save to Production' }).click();
  await expect(
    page.getByText('Saved targeting for Onboarding checklist in Production.'),
  ).toBeVisible();

  await page.reload();
  await expect(page.getByRole('slider')).toHaveValue('20');
  await expect(page.getByText('Rolling out')).toBeVisible();

  await page.getByRole('tab', { name: 'History' }).click();
  await expect(page.getByText('flipped the kill switch of')).toBeVisible();
  await page
    .getByRole('button', { name: /Show 1 change/ })
    .first()
    .click();
  await expect(page.getByText('Flag on', { exact: true })).toBeVisible();
});

test('a second editor saving first gets the other a clear conflict', async ({ browser }) => {
  const a = await newSignedInPage(browser);
  const b = await newSignedInPage(browser);
  for (const p of [a, b]) {
    await p.goto(`${base()}${P}/flags/dark-mode`);
    await expect(p.getByRole('switch', { name: 'On in Production' })).toBeVisible();
  }
  await a.getByLabel('Serve when off or a prerequisite fails').selectOption('on');
  await a.getByRole('button', { name: 'Review and save' }).click();
  await a.getByRole('button', { name: 'Save to Production' }).click();
  await expect(a.getByText(/Saved targeting/)).toBeVisible();

  await b.getByLabel('Default rule serves', { exact: true }).selectOption('off');
  await b.getByRole('button', { name: 'Review and save' }).click();
  await b.getByRole('button', { name: 'Save to Production' }).click();
  await expect(b.getByText(/Someone else saved this flag/)).toBeVisible();
  await b.getByRole('button', { name: 'Reload latest' }).click();
  await expect(b.getByLabel('Serve when off or a prerequisite fails')).toHaveValue('on');
  await a.context().close();
  await b.context().close();
});

test('viewers can look but not change anything', async ({ page }) => {
  await signIn(page, { email: 'vera@example.com', password: 'e2e viewer password 1' });
  await expect(page.getByRole('button', { name: 'Create flag' })).toHaveCount(0);
  await page.getByRole('link', { name: /New checkout/ }).click();
  await expect(page.getByRole('switch', { name: 'On in Production' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Add rule' })).toHaveCount(0);
});

test('the main journey works with the keyboard alone', async ({ page }) => {
  await page.goto(`${base()}/sign-in`);
  await page.keyboard.press('Tab');
  await expect(page.getByLabel('Email')).toBeFocused();
  await page.keyboard.type(EDITOR.email);
  await page.keyboard.press('Tab');
  await page.keyboard.type(EDITOR.password);
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Flags' })).toBeVisible();

  const focusOn = async (name: string, role: 'button' | 'switch' | 'link', limit = 40) => {
    for (let i = 0; i < limit; i++) {
      await page.keyboard.press('Tab');
      const focused = await page.evaluate(() => {
        const el = document.activeElement;
        return {
          name: el?.textContent.trim() ?? '',
          label: el?.getAttribute('aria-label') ?? '',
          role: el?.getAttribute('role') ?? el?.tagName.toLowerCase(),
        };
      });
      const roleOk =
        role === 'link'
          ? focused.role === 'a'
          : role === 'switch'
            ? focused.role === 'switch'
            : focused.role === 'button';
      if (roleOk && (focused.name.includes(name) || focused.label.includes(name))) return;
    }
    throw new Error(`could not reach ${role} "${name}" with Tab`);
  };

  await focusOn('Create flag', 'button');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByRole('dialog').getByLabel('Name')).toBeFocused();
  await page.keyboard.type('Keyboard flag');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Keyboard flag' })).toBeVisible();

  await focusOn('', 'switch');
  await page.keyboard.press('Space');
  await expect(page.getByRole('dialog', { name: /Turn on Keyboard flag/ })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Turn on' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('switch', { name: 'On in Production' })).toBeVisible();

  await page.keyboard.press('Escape');
  await focusOn('Flags', 'link');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('heading', { name: 'Flags' })).toBeVisible();
});

const PAGES: { name: string; path: string; ready: (page: Page) => Promise<void> }[] = [
  {
    name: 'flags',
    path: `${P}/flags`,
    ready: async (p) => expect(p.getByText('New checkout')).toBeVisible(),
  },
  {
    name: 'flag-targeting',
    path: `${P}/flags/new-checkout`,
    ready: async (p) => expect(p.getByRole('heading', { name: 'Who gets what' })).toBeVisible(),
  },
  {
    name: 'flag-schedules',
    path: `${P}/flags/new-checkout?tab=schedules`,
    ready: async (p) => expect(p.getByText('Scheduled', { exact: true })).toBeVisible(),
  },
  {
    name: 'flag-evaluations',
    path: `${P}/flags/new-checkout?tab=exposures`,
    ready: async (p) =>
      expect(p.getByRole('list', { name: 'Evaluations by variant' })).toBeVisible(),
  },
  {
    name: 'flag-history',
    path: `${P}/flags/new-checkout?tab=history`,
    ready: async (p) => expect(p.getByRole('list', { name: 'Change history' })).toBeVisible(),
  },
  {
    name: 'segments',
    path: `${P}/segments`,
    ready: async (p) => expect(p.getByText('Beta testers')).toBeVisible(),
  },
  {
    name: 'history',
    path: `${P}/history`,
    ready: async (p) => expect(p.getByRole('list', { name: 'Change history' })).toBeVisible(),
  },
  {
    name: 'settings',
    path: `${P}/settings`,
    ready: async (p) => expect(p.getByRole('list', { name: 'SDK keys' })).toBeVisible(),
  },
];

for (const width of [1440, 390] as const) {
  test(`every page is accessible and fits at ${width} px`, async ({ browser }) => {
    const context = await browser.newContext({
      viewport: { width, height: width === 390 ? 844 : 900 },
      deviceScaleFactor: 2,
      colorScheme: 'light',
    });
    const page = await context.newPage();
    await page.goto(`${base()}/sign-in`);
    await expectAccessible(page, 'sign-in');
    await expectNoHorizontalScroll(page, 'sign-in');
    await page.screenshot({ path: `docs/screenshots/sign-in-${width}.png` });
    await page.getByLabel('Email').fill(ADMIN.email);
    await page.getByLabel('Password').fill(ADMIN.password);
    await page.getByRole('button', { name: 'Sign in' }).click();
    await expect(page.getByRole('heading', { name: 'Flags' })).toBeVisible();

    for (const p of PAGES) {
      await page.goto(`${base()}${p.path}`);
      await p.ready(page);
      await page.evaluate(() => document.fonts.ready);
      await expectAccessible(page, p.name);
      await expectNoHorizontalScroll(page, p.name);
      await page.screenshot({
        path: `docs/screenshots/${p.name}-${width}.png`,
        fullPage: width === 1440 && p.name === 'flag-targeting',
      });
    }

    await page.goto(`${base()}${P}/flags`);
    await page.getByRole('button', { name: 'Create flag' }).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await expectAccessible(page, 'create flag dialog');
    await expectNoHorizontalScroll(page, 'create flag dialog');
    await page.keyboard.press('Escape');

    await page.goto(`${base()}${P}/flags?q=nothing-matches-this`);
    await expect(page.getByText('No flags match')).toBeVisible();
    await expectAccessible(page, 'empty flag list');
    await context.close();
  });
}

test('dark mode is accessible too', async ({ browser }) => {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 900 },
    colorScheme: 'dark',
  });
  const page = await context.newPage();
  await signIn(page);
  await expectAccessible(page, 'flags (dark)');
  await page.goto(`${base()}${P}/flags/new-checkout`);
  await expect(page.getByRole('heading', { name: 'Who gets what' })).toBeVisible();
  await expectAccessible(page, 'flag targeting (dark)');
  await page.screenshot({ path: 'docs/screenshots/flag-targeting-dark-1440.png' });
  await context.close();
});
