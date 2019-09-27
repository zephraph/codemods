/**
 * 1. Run this codemod:
 *
 * In reaction...
 *
 *    ```bash
 *    $ yarn codemod update-mp-v1-ids-to-v2
 *    ```
 *
 * 5. Find TODOs added by codemod and update where necessary
 */

import { Transform, TaggedTemplateExpression, Identifier } from "jscodeshift"
import {
  parse as parseGraphQL,
  print as printGraphQL,
  visit,
  NameNode,
  FragmentDefinitionNode,
  DefinitionNode,
  ObjectTypeDefinitionNode,
} from "graphql"
import prettier from "prettier"
import { ASTNode } from "recast"
import { schema as promisedSchema } from "./helpers/getSchema"

/**
 * Follows the selection chain in a GQL operation and returns the _parent_ type
 * from the related schema
 */
const walkSelections = (
  selections: Array<string | number> | null,
  operationChain: DefinitionNode,
  schemaPosition: any
): DefinitionNode => {
  if (selections !== null && selections.length > 2) {
    let selection = selections.shift()!
    let definition = operationChain[selection] as DefinitionNode
    let newSchemaPosition = schemaPosition
    if (typeof selection === "number") {
      newSchemaPosition = schemaPosition.fields.find(
        field => definition.name.value === field.name.value
      )
    }
    return walkSelections(selections, definition, newSchemaPosition)
  }
  return schemaPosition
}

const transform: Transform = async (file, api, _options) => {
  if (!file.source.includes("graphql`")) {
    return
  }
  const j = api.jscodeshift
  const collection = j(file.source)
  const schema = await promisedSchema

  collection
    .find(TaggedTemplateExpression, node => {
      const tag = node.tag
      return Identifier.check(tag) && tag.name === "graphql"
    })
    .forEach(path => {
      const templateElement = path.node.quasi.quasis[0]
      const graphqlDoc = parseGraphQL(templateElement.value.raw)

      const newGraphQLDoc = visit(graphqlDoc, {
        enter(node, key, parent, path, ancestors) {
          // let p = Array.isArray(parent) ? parent[0] : parent
          if (
            node.kind === "Name" &&
            parent &&
            parent.kind == "Field" &&
            (node.value === "id" ||
              node.value === "_id" ||
              node.value === "__id")
          ) {
            if (node.value === "__id") {
              node.value = "id"
              return node
            }

            if (node.value === "_id") {
              node.value = "internalID"
              return node
            }

            // Oh boy, it's an `id`, here we go...

            let fragment = ancestors.find(
              o => o && o.kind === "FragmentDefinition"
            )
            if (fragment) {
              fragment = fragment as FragmentDefinitionNode
              const fragmentTypeName = fragment.typeCondition.name.value
              const fragmentType = schema.getType(fragmentTypeName)
              if (fragmentType) {
                let parentType: ObjectTypeDefinitionNode

                try {
                  // Find the parent type of this field selection from the schema...
                  parentType = walkSelections(
                    path.slice(2),
                    fragment,
                    schema.getType(fragmentTypeName)!.astNode
                  )
                  // Filter down the parent type to just it's fields
                  const v2SchemaFields = parentType.fields
                    .filter(
                      field =>
                        field.name.value === "internalID" ||
                        field.name.value === "slug"
                    )
                    .map(field => field.name.value)

                  if (
                    v2SchemaFields.includes("slug") &&
                    v2SchemaFields.includes("internalID")
                  ) {
                    node.value = "slug"
                    return node
                  } else if (
                    !v2SchemaFields.includes("slug") &&
                    v2SchemaFields.includes("internalID")
                  ) {
                    node.value = "internalID"
                    return node
                  }
                } catch {
                  // TODO: The type wasn't found, we should inject a todo into the fragment or something
                  return undefined
                }
              }
              // TODO: Maybe inject a todo that this thing isn't a fragment and idk what to do w/ it
            }
          }
          return undefined
        },
        leave(node, key, parent, path, ancestors) {
          return undefined
        },
        // Field: (fieldNode, ...others) => {
        //   const oldName = fieldNode.name.value
        //   if (oldName === "id" || oldName === "_id" || oldName === "id") {
        //     console.log({ fieldNode })
        //     console.log(JSON.stringify(others, null, 2))
        //   }
        // const newName = camelize(oldName)
        // if (newName !== oldName) {
        //   const name: NameNode = {
        //     kind: "Name",
        //     value: newName,
        //   }
        //   const alias: NameNode = fieldNode.alias || {
        //     kind: "Name",
        //     value: oldName,
        //   }
        //   return {
        //     ...fieldNode,
        //     alias,
        //     name,
        //   }
        // }
        //   return undefined
        // },
        Argument: argNode => {
          const oldName = argNode.name.value
          // if (oldName === "__id") {
          //   const name: NameNode = {
          //     kind: "Name",
          //     value: "id",
          //   }
          //   return {
          //     ...argNode,
          //     name,
          //   }
          // }
          return undefined
        },
      })

      // @ts-ignore
      const newGraphQLDocSource = printGraphQL(newGraphQLDoc, {
        commentDescriptions: true,
      })
      const newTemplateElement = j.templateElement(
        {
          cooked: newGraphQLDocSource,
          raw: newGraphQLDocSource,
        },
        templateElement.tail
      )
      path.node.quasi.quasis[0] = newTemplateElement
    })

  return collection.toSource()
}

export default transform
export const parser = "tsx"
