# AGENTS.md

<!-- upskill:skills:start -->
## Skills

You have access to a set of skills in .claude/skills. Each skill consists of a SKILL.md file, and other files such as scripts and resources, which are referenced from there.

**YOU ARE REQUIRED TO USE THESE SKILLS TO ACCOMPLISH DEVELOPMENT TASKS. FAILING TO DO SO WILL RESULT IN WASTED TIME AND CYCLES.**

### How Skills Work

Each skill is a directory in `.claude/skills/` with the following structure:

```
.claude/skills/
  └── {skill-name}/
      ├── SKILL.md        # Main instructions (required)
      ├── scripts/        # Optional supporting scripts
      └── resources/      # Optional resources (examples, templates, etc.)
```

The SKILL.md file contains detailed instructions that you must follow exactly as written. Skills are designed to:
- Provide specialized workflows for common tasks
- Ensure consistency with project standards and best practices
- Reduce errors by codifying expert knowledge
- Chain together when tasks require multiple skill applications

### Skill Discovery and Execution Process

Always use the following process:

1. **Discovery**: When a new conversation starts, discover available skills by running `./.agents/discover-skills`. This script will show you all available skills with their names, paths, and descriptions without loading everything into context.

2. **Selection**: Use each skill based on its name and description when it feels appropriate to do so. Think carefully about all the skills available to you and choose the best ones to use. Note that some skills may reference other skills, so you may need to apply more than one skill to get things done.

3. **Execution**: When you need to use a skill:
   - Read the full SKILL.md file
   - Announce you are doing so by saying "Using Skill: {Skill Name}"
   - Follow the skill's instructions exactly as written
   - Read any referenced resources or scripts as needed
   - Complete all steps in the skill before moving to the next task

### Available Skills

Skills will be added to `.claude/skills/` as needed for this project. Check the `.claude/skills/` directory or run `./.agents/discover-skills` for the current list of available skills.

**For ALL development work involving blocks, core scripts, or functionality, you MUST start with the content-driven-development skill.** It will orchestrate other skills as needed throughout the development workflow.
<!-- upskill:skills:end -->
