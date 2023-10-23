idf_component_register(
    SRCS
    "main.cpp"
    "adc_reading.cpp"
    "proto/wsInterface.pb.c"
    "../nanopb/pb_common.c"
    "../nanopb/pb_decode.c"
    "../nanopb/pb_encode.c"
    INCLUDE_DIRS
    "."
    "../json"
    "../nanopb"
    "proto"
    "../nanopb"
    EMBED_FILES
    "webPage/index.html"
    "webPage/style.css"
    "webPage/bundle.js"
    )

# set(PROTO_FILE ${CMAKE_CURRENT_SOURCE_DIR}/proto/wsInterface.proto)
# set(GENERATED_DIR ${CMAKE_CURRENT_SOURCE_DIR}/webPage/)
# set(PROTO_PATH ${CMAKE_CURRENT_SOURCE_DIR}/proto)

# execute_process(
#     COMMAND protoc
#     --js_out=import_style=commonjs,binary:${GENERATED_DIR}
#     --proto_path=${PROTO_PATH}
#     ${PROTO_FILE}
#     WORKING_DIRECTORY ${CMAKE_CURRENT_SOURCE_DIR}
# )

#python ../nanopb/generator/nanopb_generator.py proto/wsInterface.proto && protoc --proto_path=./proto/ --js_out=import_style=commonjs,binary:./webPage wsInterface.proto && browserify -o webPage/bundle.js  webPage/main.js