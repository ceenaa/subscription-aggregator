export function subscriptionAppLinks(subscriptionUrl, name = 'Subscription') {
  const encodedUrl = encodeURIComponent(subscriptionUrl);
  const encodedName = encodeURIComponent(name);

  return [
    {
      label: 'Streisand iOS',
      href: `streisand://import/${subscriptionUrl}#${encodedName}`,
      icon: '/logos/streisand.jpg'
    },
    {
      label: 'V2Box iOS',
      href: `v2box://install-sub?url=${encodedUrl}&name=${encodedName}`,
      icon: '/logos/v2box.jpg'
    },
    {
      label: 'v2rayNG Android',
      href: `v2rayng://install-sub?url=${encodedUrl}&name=${encodedName}`,
      icon: '/logos/v2rayng.png'
    }
  ];
}
