import { definePrototype, tw } from '@proto.ui/core';

export default definePrototype({
  name: 'relay-status',
  setup(def) {
    def.feedback.style.use(tw('inline-flex items-center rounded-full px-3 py-1 text-sm'));
    return (r) => r.el('span', ['ChatGPT / Claude · MCP']);
  },
});
