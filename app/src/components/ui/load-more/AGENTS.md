# Load more

- Query owns cursors, page data and request state. This control has no feature,
  transport or cache dependencies.
- Reuse the shared Button and Spinner. Keep existing rows visible on failure,
  allow explicit retry, and disable the action during requests.
