/* Progressive enhancement: navigation and all published posts work without JS. */
(() => {
  const form = document.getElementById('archive-search');
  if (form) {
    const query = document.getElementById('post-query');
    const tag = document.getElementById('tag-filter');
    const count = document.getElementById('archive-count');
    const empty = document.getElementById('archive-empty');
    const posts = [...document.querySelectorAll('.archive-post')].map(element => {
      let tags = [];
      try { tags = JSON.parse(element.dataset.tags || '[]') || []; } catch { /* Keep text search available. */ }
      return { element, tags, search: `${element.dataset.search} ${tags.join(' ')}`.normalize('NFKC').toLocaleLowerCase() };
    });
    const years = [...document.querySelectorAll('.archive-year')];
    const initial = new URLSearchParams(location.search);
    query.value = initial.get('q') || '';
    if ([...tag.options].some(option => option.value === initial.get('tag'))) tag.value = initial.get('tag');
    const apply = (updateUrl = true) => {
      const terms = query.value.trim().normalize('NFKC').toLocaleLowerCase().split(/\s+/).filter(Boolean);
      const visibleYears = new Set();
      let visible = 0;
      posts.forEach(post => {
        const matches = terms.every(term => post.search.includes(term)) && (!tag.value || post.tags.includes(tag.value));
        post.element.hidden = !matches;
        if (matches) { visible++; visibleYears.add(post.element.dataset.year); }
      });
      years.forEach(year => { year.hidden = !visibleYears.has(year.dataset.year); });
      count.textContent = terms.length || tag.value ? `${posts.length}편 중 ${visible}편` : `전체 ${posts.length}편`;
      empty.hidden = visible !== 0;
      if (updateUrl) {
        const url = new URL(location.href);
        query.value.trim() ? url.searchParams.set('q', query.value.trim()) : url.searchParams.delete('q');
        tag.value ? url.searchParams.set('tag', tag.value) : url.searchParams.delete('tag');
        history.replaceState(null, '', url);
      }
    };
    form.hidden = false;
    form.addEventListener('submit', event => { event.preventDefault(); apply(); });
    query.addEventListener('input', () => apply());
    tag.addEventListener('change', () => apply());
    form.addEventListener('reset', () => { query.value = ''; tag.value = ''; apply(); });
    document.getElementById('clear-search').addEventListener('click', () => { form.reset(); query.focus(); });
    apply(false);
  }
  const content = document.getElementById('article-content');
  const toc = document.getElementById('article-toc');
  if (content && toc) {
    const headings = [...content.querySelectorAll('h2, h3')];
    if (headings.length > 1) {
      const list = document.getElementById('toc-list');
      headings.forEach((heading, index) => {
        if (!heading.id) { let id = `section-${index + 1}`; while (document.getElementById(id)) id += '-heading'; heading.id = id; }
        const item = document.createElement('li');
        if (heading.tagName === 'H3') item.className = 'toc-subheading';
        const link = document.createElement('a');
        link.href = `#${encodeURIComponent(heading.id)}`;
        link.textContent = heading.textContent;
        item.append(link); list.append(item);
      });
      toc.hidden = false;
      toc.open = window.matchMedia('(min-width: 1000px)').matches;
    }
  }
})();
