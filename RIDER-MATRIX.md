# Rider MCP Tool Use Matrix for qyl Repositories

The following tables define which Rider MCP tools should be used for each qyl repository.

This is a recommendation based on the supplied Rider inventory, repository architecture and project contracts. None of
the Rider MCP tools was executed while producing this matrix.

`+` means the tool should be directly available and is preferred for suitable work.
`R` means router-only through `execute_tool`, to be used conditionally.
`-` means the tool is technically related but native agent tools or repository commands are preferred.
`N/A` means the tool is not applicable to that repository. A blank cell means availability or language support is not
sufficiently verified.

For the `Baseline` column:

- `Reported` means the tool appears in the supplied Rider inventory or policy.
- `VERIFY` means it must appear in a fresh `tools/list` before being advertised.
- `GHOST` means it was reportedly exposed by documentation or UI but unavailable at runtime.

Repository abbreviations:

- `qyl.mcp` — MCP server, Workbench and dashboard
- `qyl.at` — Astro site and Cloudflare Worker
- `SemConv` — `Qyl.OpenTelemetry.SemanticConventions`
- `AutoInstr` — `Qyl.OpenTelemetry.AutoInstrumentation`

## Semantic analysis and project model

| Tool                       | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|----------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `execute_tool`             | Reported |  +  |    +    |   +    |    +    |     +     |
| `analyze_calls`            | Reported |  +  |    R    |   R    |    +    |     +     |
| `get_file_problems`        | Reported |  +  |    +    |   +    |    +    |     +     |
| `lint_files`               | Reported |  +  |    +    |   +    |    +    |     +     |
| `get_project_problems`     | Reported |  +  |    R    |   R    |    +    |     +     |
| `get_solution_projects`    | Reported |  +  |   N/A   |  N/A   |    +    |     +     |
| `get_project_dependencies` | Reported |  +  |    -    |   -    |    +    |     +     |
| `get_symbol_info`          | Reported |  +  |    +    |   +    |    +    |     +     |
| `search_symbol`            | Reported |  +  |    +    |   +    |    +    |     +     |
| `read_file`                | Reported |  +  |    R    |   R    |    +    |     +     |
| `post_edit_quality_check`  | Reported |  +  |    +    |   +    |    +    |     +     |
| `get_project_status`       | VERIFY   |     |         |        |         |           |
| `get_project_modules`      | GHOST    | N/A |   N/A   |  N/A   |   N/A   |    N/A    |

## Refactoring and formatting

| Tool                     | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|--------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `reformat_file`          | Reported |  +  |    +    |   +    |    +    |     +     |
| `rename_refactoring`     | Reported |  +  |    +    |   +    |    +    |     +     |
| `change_api_signature`   | Reported |  +  |   N/A   |  N/A   |    +    |     +     |
| `safe_delete`            | Reported |  +  |   N/A   |  N/A   |    +    |     +     |
| `move_type_to_namespace` | Reported |  R  |   N/A   |  N/A   |    R    |     R     |
| `reorganize_namespaces`  | Reported |  R  |   N/A   |  N/A   |    R    |     R     |
| `extract_method`         | Reported |  R  |   N/A   |  N/A   |    R    |     R     |
| `extract_interface`      | Reported |  R  |   N/A   |  N/A   |    R    |     R     |
| `extract_base_class`     | Reported |  R  |   N/A   |  N/A   |    R    |     R     |

Semantic refactorings must target owned, hand-written source. Generated files, snapshots, public API baselines and
generated ABI files must be regenerated through their owner rather than edited directly.

## VCS and repository boundaries

| Tool               | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|--------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `get_repositories` | Reported |  +  |    +    |   +    |    +    |     +     |
| `git_status`       | Reported |  +  |    +    |   +    |    +    |     +     |

These tools are especially useful when Rider has the complete `qyl-workspace` open because every child directory remains
an independently owned repository.

## Build and execution

| Tool                        | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|-----------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `build_solution_start`      | Reported |  +  |   N/A   |  N/A   |    +    |     +     |
| `build_solution_state`      | Reported |  +  |   N/A   |  N/A   |    +    |     +     |
| `build_project`             | Reported |  R  |    -    |   -    |    R    |     R     |
| `get_run_configurations`    | Reported |  +  |    +    |   R    |    +    |     +     |
| `execute_run_configuration` | Reported |  +  |    +    |   R    |    +    |     +     |

Rider builds are fast feedback, not acceptance gates:

| Repository  | Canonical acceptance                                                                   |
|-------------|----------------------------------------------------------------------------------------|
| `qyl`       | `dotnet run --project eng/build/build.csproj -- Ci`                                    |
| `qyl.mcp`   | pins, build, tests, smoke and OTLP smoke npm targets                                   |
| `qyl.at`    | `npm test` and `wrangler deploy --dry-run`                                             |
| `SemConv`   | Release build, both test executables, attributes hash and generator `--check` commands |
| `AutoInstr` | focused tests and `tools/verify-aot-autoinstrumentation-goal.py`                       |

## Runtime debugger

| Tool                            | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|---------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `xdebug_get_debugger_status`    | Reported |  R  |         |        |    R    |     R     |
| `xdebug_list_breakpoints`       | Reported |  R  |         |        |    R    |     R     |
| `xdebug_set_breakpoint`         | Reported |  R  |         |        |    R    |     R     |
| `xdebug_remove_breakpoint`      | Reported |  R  |         |        |    R    |     R     |
| `xdebug_start_debugger_session` | Reported |  R  |         |        |    R    |     R     |
| `xdebug_control_session`        | Reported |  R  |         |        |    R    |     R     |
| `xdebug_run_to_line`            | Reported |  R  |         |        |    R    |     R     |
| `xdebug_get_threads`            | Reported |  R  |         |        |    R    |     R     |
| `xdebug_get_stack`              | Reported |  R  |         |        |    R    |     R     |
| `xdebug_get_frame_values`       | Reported |  R  |         |        |    R    |     R     |
| `xdebug_get_value_by_path`      | Reported |  R  |         |        |    R    |     R     |
| `xdebug_evaluate_expression`    | Reported |  R  |         |        |    R    |     R     |
| `xdebug_set_variable`           | Reported |  -  |         |        |    -    |     -     |
| `xdebug_attach_to_process`      | Reported |  R  |         |        |    -    |     R     |
| `attach_to_process`             | Reported |  R  |         |        |    -    |     R     |
| `xdebug_memory_dump`            | Reported |  R  |   N/A   |  N/A   |   N/A   |     R     |
| `xdebug_start_mixed_mode_debug` | Reported |  R  |   N/A   |  N/A   |   N/A   |     R     |
| `ignore_exception`              | Reported |  R  |         |        |    -    |     R     |

The debugger is most valuable for:

- `qyl`: collector concurrency, workflow processing, shutdown and NativeAOT/runtime behavior
- `SemConv`: rare Roslyn generator or analyzer state that tests do not expose
- `AutoInstr`: DiagnosticListener payloads, Activity creation, module initializers, interceptors and real demo execution

Node, browser and Astro support for the listed `xdebug_*` tools is left blank until confirmed by the exact runtime
schemas.

## Database inspection

All database access requires a genuinely read-only Rider data source. The tools themselves do not enforce read-only
behavior.

| Tool                              | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|-----------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `list_database_connections`       | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `create_database_connection`      | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `edit_database_connection`        | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `test_database_connection`        | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `introspect_schema`               | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `list_database_schemas`           | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `list_schema_object_kinds`        | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `list_schema_objects`             | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_database_object_description` | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `preview_table_data`              | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `execute_sql_query`               | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `fetch_query_result`              | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `list_recent_sql_queries`         | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |
| `cancel_sql_query`                | Reported |  R  |   N/A   |  N/A   |   N/A   |    N/A    |

The database demos in `AutoInstr` do not justify enabling database tools: they verify emitted instrumentation, not owned
database schemas or business data.

## Generic file and text tools

These tools mostly duplicate native agent filesystem operations.

| Tool                         | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `create_new_file`            | Reported |  -  |    -    |   -    |    -    |     -     |
| `apply_patch`                | Reported |  -  |    -    |   -    |    -    |     -     |
| `get_all_open_file_paths`    | Reported |  R  |    R    |   R    |    R    |     R     |
| `list_directory_tree`        | Reported |  -  |    -    |   -    |    -    |     -     |
| `open_file_in_editor`        | Reported |  R  |    R    |   R    |    R    |     R     |
| `execute_terminal_command`   | Reported |  -  |    -    |   -    |    -    |     -     |
| `search_file`                | Reported |  -  |    -    |   -    |    -    |     -     |
| `search_regex`               | Reported |  -  |    -    |   -    |    -    |     -     |
| `search_text`                | Reported |  -  |    -    |   -    |    -    |     -     |
| `find_files_by_glob`         | VERIFY   |     |         |        |         |           |
| `find_files_by_name_keyword` | VERIFY   |     |         |        |         |           |
| `get_file_text_by_path`      | VERIFY   |     |         |        |         |           |
| `replace_text_in_file`       | VERIFY   |     |         |        |         |           |
| `search_in_files_by_regex`   | VERIFY   |     |         |        |         |           |
| `search_in_files_by_text`    | VERIFY   |     |         |        |         |           |

`get_all_open_file_paths` and `open_file_in_editor` remain router-only because they are useful only when the user
explicitly wants the current Rider working set considered or a result opened in the IDE.

## Unrelated language and IDE tools

| Tool                                 | Baseline | qyl | qyl.mcp | qyl.at | SemConv | AutoInstr |
|--------------------------------------|----------|:---:|:-------:|:------:|:-------:|:---------:|
| `find_lock_requirement_usages`       | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `find_threading_requirements_usages` | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `generate_inspection_kts_api`        | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `generate_inspection_kts_examples`   | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `generate_psi_tree`                  | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `run_inspection_kts`                 | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `validate_inspection_kts`            | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `runNotebookCell`                    | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_routes`                   | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_models`                   | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_controllers`              | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_helpers`                  | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_views`                    | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
| `get_rails_mailers`                  | Reported | N/A |   N/A   |  N/A   |   N/A   |    N/A    |
``
## Recommended direct exposure summary

| Repository                              | Direct semantic toolset | Conditional router focus                                                 |
|-----------------------------------------|------------------------:|--------------------------------------------------------------------------|
| `qyl`                                   |                22 tools | Debugger, database inspection and uncommon structural refactoring        |
| `qyl.mcp`                               |                12 tools | TypeScript call analysis and focused execution                           |
| `qyl.at`                                |                10 tools | Astro-aware symbol operations and optional run configurations            |
| `Qyl.OpenTelemetry.SemanticConventions` |                21 tools | Generator debugging and uncommon structural refactoring                  |
| `Qyl.OpenTelemetry.AutoInstrumentation` |                21 tools | Runtime debugger, process attachment and uncommon structural refactoring |

The central policy is: keep Rider’s semantic intelligence directly available, keep expensive or stateful operations
behind `execute_tool`, and disable wrappers that merely duplicate native file, search, shell or patch functionality.
