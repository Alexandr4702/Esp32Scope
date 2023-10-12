idf_component_register(
    SRCS "main.cpp" "adc_reading.cpp"
    INCLUDE_DIRS "." "../json/" "../nanopb" "proto/"
    EMBED_FILES "webPage/index.html" "webPage/style.css" "webPage/main.js" "proto/protobuf.js" "proto/wsInterface_pb.js")

set(PROTO_FILE ${CMAKE_CURRENT_SOURCE_DIR}/proto/wsInterface.proto)
set(GENERATED_DIR ${CMAKE_CURRENT_SOURCE_DIR}/proto/)
set(PROTO_PATH ${CMAKE_CURRENT_SOURCE_DIR}/proto)

execute_process(
    COMMAND protoc
    --nanopb_out=${GENERATED_DIR}
    --js_out=import_style=commonjs,binary:${GENERATED_DIR}
    --proto_path=${PROTO_PATH}
    ${PROTO_FILE}
    WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
)