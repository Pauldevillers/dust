import type { Meta, StoryObj } from "@storybook/react";
import { IconToggleButton, Cog6ToothIcon } from "sparkle";

const meta = {
  title: "Atoms/IconToggleButton",
  component: IconToggleButton,
} satisfies Meta<typeof IconToggleButton>;

export default meta;
type Story = StoryObj<typeof meta>;

export const IconToggleButtonSecondary: Story = {
  args: {
    type: "secondary",
    tooltip: "This a secondary IconButton",
    icon: Cog6ToothIcon,
    selected: false,
  },
};

export const IconToggleButtonTertiary: Story = {
  args: {
    type: "tertiary",
    tooltip: "This a tertiary IconButton",
    icon: Cog6ToothIcon,
    selected: false,
  },
};
