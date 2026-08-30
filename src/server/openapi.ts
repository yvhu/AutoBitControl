/**
 * OpenAPI 文档（server 层）：swagger-jsdoc 从各路由文件的 @swagger 注解聚合生成 spec
 * 依赖方向：无业务依赖（纯文档聚合）；被 app 装配（GET /api/docs/openapi.json 与 /api-docs 页面）
 * 设计思路：注解直接写在路由旁（apis: routes/*.ts），改接口时同步改文档；Task 2 前端类型生成依赖此 spec
 */
import swaggerJsdoc from 'swagger-jsdoc'

export const openapiSpec = swaggerJsdoc({
  definition: {
    openapi: '3.0.3',
    info: { title: 'AutoBitControl API', version: '0.1.0', description: '面板与自动化引擎的全部接口' },
    servers: [{ url: 'http://127.0.0.1:3000' }],
  },
  apis: ['src/server/routes/*.ts'],
})
