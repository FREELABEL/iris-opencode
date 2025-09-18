import { Plugin, tool, z } from "./index"

const foo = tool("mytool", {
  description: "This is a tool",
  parameters: z.object({
    foo: z.string(),
  }),
  async execute(params) {
    return {
      output,
    }
  },
})

export const ExamplePlugin: Plugin = async ({}) => {
  return {
    permission: {},
    tool: {},
    async "chat.params"(_input, output) {
      output.topP = 1
    },
  }
}
