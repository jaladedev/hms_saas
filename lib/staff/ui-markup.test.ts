import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { EmptyState, ErrorBanner, headRow, linkClass, PageIntro, StatTile, tdNum, thNum, thRowHead, totalRow } from "@/components/staff/ui";

// These pieces replaced markup that was written out by hand on many pages. The expected strings below are that
// original markup, so a change here that alters what a page shows fails this test instead of passing unnoticed.
const html = (el: ReturnType<typeof createElement>) => renderToStaticMarkup(el);

describe("shared staff UI pieces keep the markup they replaced", () => {
  it("ErrorBanner: red bar, announced to screen readers, spacing from the caller", () => {
    expect(html(createElement(ErrorBanner, { className: "mt-6", children: "Could not load" })))
      .toBe('<p role="alert" class="mt-6 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">Could not load</p>');
    expect(html(createElement(ErrorBanner, { className: "mb-5", children: "x" })))
      .toBe('<p role="alert" class="mb-5 border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">x</p>');
  });

  it("ErrorBanner with no spacing has no stray space in the class", () => {
    expect(html(createElement(ErrorBanner, { children: "x" })))
      .toBe('<p role="alert" class="border-l-4 border-critical bg-critical/5 px-4 py-3 text-sm text-critical">x</p>');
  });

  it("EmptyState with and without spacing", () => {
    expect(html(createElement(EmptyState, { className: "mt-6", children: "Nothing here" })))
      .toBe('<p class="mt-6 rounded border border-line bg-white px-4 py-6 text-muted">Nothing here</p>');
    expect(html(createElement(EmptyState, { children: "Nothing here" })))
      .toBe('<p class="rounded border border-line bg-white px-4 py-6 text-muted">Nothing here</p>');
  });

  it("PageIntro", () => {
    expect(html(createElement(PageIntro, { children: "About this page" })))
      .toBe('<p class="mt-2 max-w-prose text-muted">About this page</p>');
  });

  it("StatTile: label, value and note", () => {
    expect(html(createElement(StatTile, { label: "Occupancy", value: "62%", note: "5 of 8 room nights" })))
      .toBe('<div class="rounded border border-line bg-white p-4"><p class="text-sm text-muted">Occupancy</p><p class="mt-1 font-display text-2xl tabular-nums">62%</p><p class="mt-1 text-xs text-muted">5 of 8 room nights</p></div>');
  });

  it("linkClass is the link style that was repeated on the pages", () => {
    expect(linkClass).toBe("text-primary-strong underline underline-offset-2");
  });

  it("table styles are the strings the report and calendar tables used", () => {
    expect(thNum).toBe("px-2 py-2 text-right font-normal");
    expect(tdNum).toBe("px-2 py-2 text-right");
    expect(thRowHead).toBe("py-2 pr-3 text-left font-normal");
    expect(headRow).toBe("border-b border-line text-left text-muted");
    expect(totalRow).toBe("font-semibold tabular-nums");
  });
});
