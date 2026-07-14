function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function mountFeaturePlaceholder(container, context, options = {}) {
  const { group, feature } = context;
  const highlights = Array.isArray(options.highlights) ? options.highlights : [];
  const nextSteps = Array.isArray(options.nextSteps) ? options.nextSteps : [];

  container.innerHTML = `
    <article class="feature-placeholder" data-feature="${escapeHtml(feature.id)}">
      <header class="feature-hero">
        <span class="feature-path">${escapeHtml(group.name)} / ${escapeHtml(feature.name)}</span>
        <h2>${escapeHtml(feature.name)}</h2>
        <p>${escapeHtml(feature.description)}</p>
        <span class="placeholder-pill">功能骨架已就绪</span>
      </header>

      <section class="feature-panel">
        <h3>计划能力</h3>
        <ul>
          ${highlights.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ul>
      </section>

      <section class="feature-panel feature-next">
        <h3>接入顺序</h3>
        <ol>
          ${nextSteps.map((item) => `<li>${escapeHtml(item)}</li>`).join("")}
        </ol>
      </section>
    </article>
  `;

  return () => {
    container.replaceChildren();
  };
}
