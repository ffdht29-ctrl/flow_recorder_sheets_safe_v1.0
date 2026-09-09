# flow_recorder_sheets_safe_v1.0
=======================

自动记录每个人在flow中生成视频使用的积分
使用方法：
需要在google创建一个表格，并打开可编辑的权限，之后共享，之后记录的数据就保存到这个表格中。
然后进入https://script.google.com/home  这个链接中，给这个共享的表格设置一个脚本的标记
进入这个网站之后，创建一个新的项目，把  AppsScript_GoogleSheets_Safe.gs  这个文件中所有的代码都复制到这个工程中，
<img width="956" height="201" alt="image" src="https://github.com/user-attachments/assets/741cae02-de70-4bb7-ba22-666e759d05f9" />
这两个地方需要自己设置一个，一个是刚刚共享的google的表格的链接，不是整个链接，是google表格中的一部分，
比如整个连接是   https://docs.google.com/spreadsheets/d/1Oflxxxxxxx1114584XrXCTBeeeeeeeeA77lqOtCjpjuvk/edit?usp=sharing
只用吧1Oflxxxxxxx1114584XrXCTBeeeeeeeeA77lqOtCjpjuvk这一部分复制，填写到ID的那个地方
第二个地方是设置一个密钥，这个密钥是自己设置的，设置好之后需要保存下来，一会要用。
这两个地方设置好之后ctrl+s 保存。
<img width="1067" height="268" alt="image" src="https://github.com/user-attachments/assets/937f2128-77aa-4471-b97c-b8381dd6e987" />
按这个图片中的步骤操作。
<img width="584" height="440" alt="image" src="https://github.com/user-attachments/assets/8210a0fa-619d-4bb7-9141-d0003971e2e3" />
<img width="989" height="326" alt="image" src="https://github.com/user-attachments/assets/92cbbb14-564e-4d7e-b883-3d1558c8b86c" />
<img width="493" height="132" alt="image" src="https://github.com/user-attachments/assets/f358daea-d77f-4948-8e96-d846dedf9970" />
<img width="750" height="296" alt="image" src="https://github.com/user-attachments/assets/6490079f-0dbc-42d5-b18a-82e9c95e77f1" />
<img width="1115" height="253" alt="image" src="https://github.com/user-attachments/assets/87a18f7a-c77c-4c7b-8a32-d47c007332ff" />
<img width="649" height="489" alt="image" src="https://github.com/user-attachments/assets/a0c8af71-419a-4fa0-8893-8c5ed69c112b" />
<img width="1613" height="1002" alt="image" src="https://github.com/user-attachments/assets/cdb27629-ed58-4b20-adef-3037e8675654" />
<img width="1490" height="692" alt="image" src="https://github.com/user-attachments/assets/ee53da05-08e2-42b1-befb-0db720800361" />
<img width="1821" height="729" alt="image" src="https://github.com/user-attachments/assets/6510b034-46b3-4575-b32d-f1ec1348ac17" />
之后就是把插件安装到浏览器上。对插件进行一个设置
<img width="1065" height="502" alt="image" src="https://github.com/user-attachments/assets/403ab160-8bd7-4801-a7da-e22ad6ed66cd" />
<img width="1282" height="602" alt="image" src="https://github.com/user-attachments/assets/3ee6b45c-7f3a-417f-b6ff-250f1688316c" />
这些都设置好，在安装了插件的浏览器上新打开一个flow，之后就开始记录了。
如果是生成图片，或使用不要积分的模型，插件只会记录生成时的信息，但不会跟踪是否成功，只会记录生成的数量。如果需要使用积分，插件会持续跟踪这个视频最后
是否成功，只有成功生成这个视频才会记录积分。中途失败或手动取消不会记录积分。
编写的时候就是这么要求的，可能会有记录失败的地方，不过这种情况并不多。
