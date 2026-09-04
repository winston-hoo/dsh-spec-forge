# 示例：Spring Boot 新增分页查询接口

> 这是一个沉淀后的模板长什么样。它由 `spec_retro` 自动生成，不是手写文档。
> 放在 `templates/` 目录仅作示例，不会被插件加载。

分类：`feature/api`　标签：`java` `spring-boot` `mybatis-plus` `pagination`

## 触发场景

当用户要求「新增一个 XXX 查询接口，支持分页」或「列表页要能翻页」时适用。

## 需求澄清清单

- 分页参数是 pageNum/pageSize 还是 offset/limit？
- 返回 VO 是否包含关联表字段（如部门名称、创建人姓名）？
- 是否需要同时提供导出 Excel 的能力？
- 排序字段和排序方向是否由前端传入？
- 是否需要数据权限过滤（只能看本部门数据）？

## 标准改法

1. 在 `XxxController` 新增方法，路径遵循 RESTful 约定，参数用 `XxxQuery` 对象接收而非散装参数
2. `XxxQuery` 继承公共分页基类，业务字段单独定义，校验注解写在字段上
3. `XxxService` 接口声明方法，`XxxServiceImpl` 实现，分页用 MyBatis-Plus 的 `Page` 对象
4. Mapper XML 写查询 SQL，关联表用 `<left join>`，不要用嵌套子查询
5. 返回统一用 `Result<PageResult<XxxVO>>`，不要在 Controller 里手工拼装
6. 补充单元测试，覆盖分页参数边界（第 0 页、超出总页数）与空结果

## 禁区

- 不要修改 `common/Result.java` 的返回结构，它是全站统一契约
- 不要修改 `MybatisPlusConfig` 中的分页插件配置
- 不要在 Controller 层写业务逻辑，Controller 只做参数接收与结果返回
- 不要新增全局拦截器来解决单个接口的权限问题

## 提示词模板

```text
在 <模块名> 中新增一个分页查询接口，要求：
1. 严格按 Controller → Service → ServiceImpl → Mapper 四层实现
2. 分页参数用 pageNum/pageSize，返回统一封装为 Result<PageResult<XxxVO>>
3. 查询条件：<列举字段>，支持模糊匹配的字段：<列举>
4. 不修改 common/Result.java 与 MybatisPlusConfig
5. 补充单元测试，覆盖空结果与边界分页参数
6. 完成后运行 mvn -q test 并报告结果
```

## 验收标准

- [ ] `mvn -q test` 通过，无新增失败用例
- [ ] 新接口有单测覆盖，包含空结果与边界分页参数
- [ ] 未修改 `common/Result.java` 与 `MybatisPlusConfig`
- [ ] 接口返回结构与既有接口保持一致
