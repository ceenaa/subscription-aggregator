export function clientsPagination(clients, url, defaultSize = 50) {
  const query = (url.searchParams.get('q') || '').trim().slice(0, 200);
  const search = query.toLowerCase();
  const matches = search
    ? clients.filter(client => `${client.email || ''} ${client.subId}`.toLowerCase().includes(search))
    : clients;
  const pageSize = Math.min(100, Math.max(1, Number.parseInt(url.searchParams.get('pageSize'), 10) || defaultSize));
  const pages = Math.max(1, Math.ceil(matches.length / pageSize));
  const page = Math.min(pages, Math.max(1, Number.parseInt(url.searchParams.get('page'), 10) || 1));
  const href = number => {
    const params = new URLSearchParams({ page: String(number), pageSize: String(pageSize) });
    if (query) params.set('q', query);
    if (url.searchParams.get('usage') === 'subscription') params.set('usage', 'subscription');
    return `/clients?${params}`;
  };
  return {
    items: matches.slice((page - 1) * pageSize, page * pageSize),
    query, page, pageSize, pages, filtered: matches.length,
    start: matches.length ? (page - 1) * pageSize + 1 : 0,
    end: Math.min(page * pageSize, matches.length),
    previousUrl: page > 1 ? href(page - 1) : '',
    nextUrl: page < pages ? href(page + 1) : '',
    currentUrl: href(page)
  };
}
